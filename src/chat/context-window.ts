import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { wrapLanguageModel, type ModelMessage } from 'ai';
import { z } from 'zod';
import type { Workspace } from '../conversations/conversation.entity.js';
import { lmStudioModelsUrl } from './lm-studio-thinking.service.js';

export const contextRequestSchema = z.object({
    conversationId: z.string().min(1).max(100).optional(),
    draft: z.string().trim().max(20_000),
    thinking: z.boolean().optional(),
    webSearch: z.boolean().optional(),
});

export type ContextRequest = z.infer<typeof contextRequestSchema>;

export type ContextEstimate = {
    windowTokens: number | null;
    inputTokens: number;
    reservedOutputTokens: number;
    remainingTokens: number | null;
    overBudgetTokens: number | null;
    pendingSearch?: true;
    step?: number;
};

type PromptEntry = { role: string; content: unknown };
type Model = Parameters<typeof wrapLanguageModel>[0]['model'];
type Observe = (
    prompt: PromptEntry[],
    tools: unknown,
    outputTokens?: number,
) => Promise<void>;
const observer = new AsyncLocalStorage<Observe>();

export function withContextReporting(model: Model) {
    return wrapLanguageModel({
        model,
        middleware: {
            specificationVersion: 'v4',
            async transformParams({ params }) {
                await observer
                    .getStore()?.(
                        params.prompt,
                        params.tools,
                        params.maxOutputTokens,
                    )
                    .catch(() => undefined);
                return params;
            },
        },
    });
}

const loadedModels = z.object({
    models: z.array(
        z.object({
            key: z.string(),
            loaded_instances: z
                .array(
                    z.object({
                        id: z.string(),
                        config: z
                            .object({
                                context_length: z
                                    .number()
                                    .int()
                                    .nonnegative()
                                    .nullish(),
                            })
                            .nullish(),
                    }),
                )
                .nullish(),
        }),
    ),
});

function textTokens(text: string) {
    let count = 0;
    for (const { 0: part } of text.matchAll(/[0-9A-Za-z_]+|[^\s]/gu)) {
        count += Math.ceil(part.length / 4);
    }
    return count;
}

function contentTokens(content: unknown): number {
    if (typeof content === 'string') return textTokens(content);
    if (Array.isArray(content)) {
        return content.reduce<number>((sum, part: unknown) => {
            if (
                part &&
                typeof part === 'object' &&
                'type' in part &&
                part.type === 'text' &&
                'text' in part
            ) {
                return sum + contentTokens(part.text);
            }
            return sum + textTokens(JSON.stringify(part) ?? '');
        }, 0);
    }
    return textTokens(JSON.stringify(content) ?? '');
}

@Injectable()
export class ContextWindowService {
    private readonly limits = new Map<
        Workspace,
        { key: string; expires: number; value: Promise<number | null> }
    >();

    constructor(private readonly config: ConfigService) {}

    preview(
        workspace: Workspace,
        instructions: string,
        messages: ModelMessage[],
        request: ContextRequest,
        tools?: unknown,
    ) {
        const prompt: PromptEntry[] = [
            { role: 'system', content: instructions },
            ...messages,
        ];
        if (request.draft)
            prompt.push({ role: 'user', content: request.draft });
        const reserved = this.outputBudget(workspace, request.thinking);
        return this.estimate(
            workspace,
            prompt,
            tools,
            reserved,
            request.webSearch === true,
        );
    }

    observe<T>(
        workspace: Workspace,
        thinking: boolean | undefined,
        callback: (value: ContextEstimate) => void,
        run: () => T,
    ) {
        let step = 0;
        return observer.run(async (prompt, tools, outputTokens) => {
            const estimate = await this.estimate(
                workspace,
                prompt,
                tools,
                outputTokens ?? this.outputBudget(workspace, thinking),
            );
            callback({ ...estimate, step: ++step });
        }, run);
    }

    private async estimate(
        workspace: Workspace,
        prompt: PromptEntry[],
        tools: unknown,
        reservedOutputTokens: number,
        pendingSearch = false,
    ): Promise<ContextEstimate> {
        const windowTokens = await this.limit(workspace);
        // Include a small framing allowance per message; model templates vary.
        const inputTokens =
            3 +
            prompt.reduce(
                (sum, { content }) => sum + 4 + contentTokens(content),
                0,
            ) +
            contentTokens(tools);
        const headroom =
            windowTokens === null
                ? null
                : windowTokens - inputTokens - reservedOutputTokens;
        return {
            windowTokens,
            inputTokens,
            reservedOutputTokens,
            remainingTokens: headroom === null ? null : Math.max(0, headroom),
            overBudgetTokens: headroom === null ? null : Math.max(0, -headroom),
            ...(pendingSearch && { pendingSearch: true }),
        };
    }

    private outputBudget(workspace: Workspace, thinking?: boolean) {
        const prefix = workspace === 'chat' ? 'AI' : 'AGENT';
        const defaultBudget = thinking
            ? 4096
            : workspace === 'chat'
              ? 1024
              : 2048;
        return (
            this.config.get<number>(
                `${prefix}_${thinking ? 'DEEP_' : ''}MAX_OUTPUT_TOKENS`,
            ) ?? defaultBudget
        );
    }

    private limit(workspace: Workspace): Promise<number | null> {
        const prefix = workspace === 'chat' ? 'AI' : 'AGENT';
        const fallback =
            this.config.get<number>(`${prefix}_CONTEXT_WINDOW_TOKENS`) ?? null;
        const baseURL = this.config.get<string>(`${prefix}_BASE_URL`);
        const model = this.config.get<string>(`${prefix}_MODEL`);
        if (
            this.config.get(`${prefix}_PROVIDER`) !== 'lm-studio' ||
            !baseURL ||
            !model
        )
            return Promise.resolve(fallback);
        const key = JSON.stringify([baseURL, model, fallback]);
        const cached = this.limits.get(workspace);
        if (cached?.key === key && cached.expires > Date.now())
            return cached.value;
        const value = this.loadedContext(
            baseURL,
            model,
            this.config.get<string>(`${prefix}_API_KEY`),
        ).then((capacity) => capacity ?? fallback);
        this.limits.set(workspace, {
            key,
            expires: Date.now() + 15_000,
            value,
        });
        return value;
    }

    private async loadedContext(baseURL: string, model: string, key?: string) {
        try {
            const response = await fetch(lmStudioModelsUrl(baseURL), {
                headers: key ? { Authorization: `Bearer ${key}` } : undefined,
                signal: AbortSignal.timeout(1000),
            });
            if (!response.ok) return null;
            const { models } = loadedModels.parse(await response.json());
            const instances = models.flatMap(
                (item) => item.loaded_instances ?? [],
            );
            const exact = instances.find(({ id }) => id === model);
            if (exact?.config?.context_length)
                return exact.config.context_length;
            const matching = models.find(
                ({ key }) => key === model,
            )?.loaded_instances;
            return matching?.length === 1
                ? matching[0].config?.context_length || null
                : null;
        } catch {
            return null;
        }
    }
}

@Module({
    imports: [ConfigModule],
    providers: [ContextWindowService],
    exports: [ContextWindowService],
})
export class ContextWindowModule {}
