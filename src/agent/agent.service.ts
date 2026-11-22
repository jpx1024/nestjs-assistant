import { AiService } from '@nestjs/ai';
import {
    BadRequestException,
    Injectable,
    Logger,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import {
    createUIMessageStreamResponse,
    type ModelMessage,
    type UIMessageChunk,
} from 'ai';
import type { ReplyOutcome } from '../chat/chat.service.js';
import {
    ContextWindowService,
    type ContextRequest,
    type ContextEstimate,
} from '../chat/context-window.js';
import { LmStudioThinkingService } from '../chat/lm-studio-thinking.service.js';
import { SystemPromptTemplate } from '../chat/prompt.service.js';
import {
    addPartialUsage,
    reportedUsage,
    type ReplyUsage,
} from '../chat/reply-usage.js';
import {
    type AgentRunBudget,
    searchInput,
    searchToolName,
    searchToolDescription,
} from './agent-search.js';
import { type SearchActivity, searchOutput } from '../search/web-search.js';
import { AgentStore } from './agent.store.js';

export const agentModelName = 'agent';

@Injectable()
export class AgentService {
    private readonly logger = new Logger(AgentService.name);
    private readonly prompt: SystemPromptTemplate;

    constructor(
        private readonly config: ConfigService,
        private readonly ai: AiService,
        private readonly store: AgentStore,
        private readonly thinking: LmStudioThinkingService,
        private readonly contextWindow: ContextWindowService,
    ) {
        this.prompt = new SystemPromptTemplate(
            config,
            new URL('../../prompts/agent.system.md', import.meta.url),
        );
    }

    contextPreview(messages: ModelMessage[], request: ContextRequest) {
        const webSearch = this.searchAvailable();
        return this.contextWindow.preview(
            'agent',
            this.prompt.renderSystemPrompt(),
            messages,
            { ...request, webSearch },
            webSearch
                ? [
                      {
                          name: searchToolName,
                          description: searchToolDescription,
                          inputSchema: z.toJSONSchema(searchInput),
                      },
                  ]
                : undefined,
        );
    }

    async model() {
        const provider = this.config.getOrThrow<string>('AGENT_PROVIDER');
        const model = this.config.get<string>('AGENT_MODEL') || null;
        const modelAvailable = Boolean(
            model &&
            (provider === 'lm-studio' ||
                this.config.get<string>('AGENT_API_KEY')),
        );
        return {
            provider,
            model,
            modelAvailable,
            searchAvailable: this.searchAvailable(),
            thinkingAvailable:
                modelAvailable && (await this.thinkingAvailable()),
        };
    }

    async reply(
        id: string,
        client: AbortSignal,
        message?: { content: string; thinking?: boolean },
    ): Promise<Response> {
        const provider = this.config.getOrThrow<string>('AGENT_PROVIDER');
        if (!this.config.get<string>('AGENT_MODEL')) {
            throw new ServiceUnavailableException(
                'Configure AGENT_MODEL to start an Agent reply.',
            );
        }
        if (
            provider === 'openai' &&
            !this.config.get<string>('AGENT_API_KEY')
        ) {
            throw new ServiceUnavailableException(
                'Configure AGENT_API_KEY to use the Agent model.',
            );
        }
        if (
            message?.thinking !== undefined &&
            !(await this.thinkingAvailable())
        ) {
            throw new BadRequestException(
                'The configured Agent model cannot switch thinking modes.',
            );
        }
        client.throwIfAborted();
        const turn = await this.store.beginRun(id, message);
        const searches = new Map<string, SearchActivity>();
        let content = '';
        let usage: ReplyUsage | undefined;
        let settlement: Promise<boolean> | undefined;
        const save = async (
            status: ReplyOutcome['status'],
            history?: ModelMessage[],
        ) => {
            client.removeEventListener('abort', stop);
            const records = [...searches.values()].map((activity) => ({
                ...activity,
                status:
                    activity.status === 'searching'
                        ? ('stopped' as const)
                        : activity.status,
            }));
            try {
                await this.store.finishRun(
                    turn.run,
                    { content, status, ...(usage && { usage }) },
                    records,
                    history,
                );
                return true;
            } catch (error) {
                this.logger.error('Could not save Agent run', error);
                return false;
            }
        };
        const settle = (
            status: ReplyOutcome['status'],
            history?: ModelMessage[],
        ) => (settlement ??= save(status, history));
        const stop = () => {
            void settle('stopped');
        };
        client.addEventListener('abort', stop, { once: true });
        const timeout = AbortSignal.timeout(
            this.config.getOrThrow<number>('AGENT_TIMEOUT_MS'),
        );
        const errorText = () =>
            timeout.aborted
                ? 'The Agent took too long to respond.'
                : 'The Agent model or tool request failed.';

        try {
            if (
                !message &&
                turn.thinking !== undefined &&
                !(await this.thinkingAvailable())
            ) {
                throw new BadRequestException(
                    'The configured Agent model cannot switch thinking modes.',
                );
            }
            client.throwIfAborted();
            const maxSteps = this.config.getOrThrow<number>('AGENT_MAX_STEPS');
            const maxOutputTokens = this.config.getOrThrow<number>(
                turn.thinking
                    ? 'AGENT_DEEP_MAX_OUTPUT_TOKENS'
                    : 'AGENT_MAX_OUTPUT_TOKENS',
            );
            const budget: AgentRunBudget = { searchesRemaining: maxSteps - 1 };
            const contextUpdates: ContextEstimate[] = [];
            const answer = this.contextWindow.observe(
                'agent',
                turn.thinking,
                (value) => contextUpdates.push(value),
                () =>
                    this.ai.streamText({
                        model: agentModelName,
                        label: 'agent',
                        instructions: this.prompt.renderSystemPrompt(),
                        messages: turn.context,
                        ...(this.searchAvailable()
                            ? { tools: [searchToolName] }
                            : {}),
                        caller: { user: budget },
                        maxSteps,
                        maxOutputTokens,
                        onUsage: (event) => {
                            usage = addPartialUsage(usage, event.usage);
                        },
                        abortSignal: AbortSignal.any([client, timeout]),
                        providerOptions: {
                            openai: {
                                store: false,
                                systemMessageMode: 'system',
                                parallelToolCalls: false,
                                ...(turn.thinking !== undefined && {
                                    forceReasoning: true,
                                    reasoningEffort: turn.thinking
                                        ? 'high'
                                        : 'none',
                                    reasoningSummary: null,
                                }),
                            },
                        },
                    }),
            );

            const record = async (part: UIMessageChunk) => {
                const activity = this.searchActivity(part, searches);
                if (activity && !settlement) {
                    searches.set(activity.id, activity);
                    await this.store.recordSearches(turn.run, [
                        ...searches.values(),
                    ]);
                }
                return activity;
            };
            const stream = answer.toUIMessageStream({ errorText }).pipeThrough(
                new TransformStream<UIMessageChunk, UIMessageChunk>({
                    async transform(part, controller) {
                        for (const data of contextUpdates.splice(0)) {
                            controller.enqueue({ type: 'data-context', data });
                        }
                        const activity = await record(part);
                        if (activity) {
                            controller.enqueue({
                                type: 'data-agent-search',
                                id: activity.id,
                                data: activity,
                            });
                            return;
                        }
                        if (part.type.startsWith('tool-')) return;
                        if (part.type === 'text-delta') content += part.delta;
                        let failure: string | undefined;
                        let history: ModelMessage[] | undefined;
                        if (part.type === 'finish') {
                            const counts = await answer.usage;
                            usage = reportedUsage(counts) ?? usage;
                            const empty = !content.trim();
                            const limit =
                                part.finishReason === 'length' ||
                                (empty &&
                                    counts.outputTokens >=
                                        Math.max(1, maxOutputTokens - 1));
                            failure = limit
                                ? 'The Agent reached the output token limit.'
                                : part.finishReason === 'tool-calls'
                                  ? 'The Agent reached its tool step limit.'
                                  : empty
                                    ? 'The Agent ended without a text answer.'
                                    : undefined;
                            if (!failure) {
                                history = (
                                    await answer.responseMessages
                                ).flatMap((entry) => {
                                    if (
                                        entry.role !== 'assistant' ||
                                        typeof entry.content === 'string'
                                    )
                                        return [entry];
                                    const parts = entry.content.filter(
                                        (item) => item.type !== 'reasoning',
                                    );
                                    return parts.length
                                        ? [{ ...entry, content: parts }]
                                        : [];
                                });
                            }
                        }
                        if (part.type === 'finish' || part.type === 'error') {
                            const saved = await settle(
                                failure || part.type === 'error'
                                    ? 'failed'
                                    : 'complete',
                                history,
                            );
                            if (saved && usage) {
                                controller.enqueue({
                                    type: 'data-usage',
                                    data: usage,
                                });
                            }
                            const terminalError = saved
                                ? failure
                                : 'The Agent reply could not be saved.';
                            if (terminalError) {
                                controller.enqueue({
                                    type: 'error',
                                    errorText: terminalError,
                                });
                                return;
                            }
                        }
                        controller.enqueue(part);
                    },
                    async flush(controller) {
                        if (!settlement) {
                            await settle('failed');
                            controller.enqueue({
                                type: 'error',
                                errorText: errorText(),
                            });
                        }
                    },
                }),
            );
            return createUIMessageStreamResponse({
                stream,
                keepAliveMs: 15_000,
            });
        } catch (error) {
            await settle(client.aborted ? 'stopped' : 'failed');
            throw error;
        }
    }

    private searchAvailable() {
        return (
            this.config.get<string>('AGENT_SEARCH_PROVIDER') === 'deepseek' &&
            Boolean(this.config.get<string>('DEEPSEEK_SEARCH_API_KEY'))
        );
    }

    private thinkingAvailable(): Promise<boolean> {
        const modelId = this.config.get<string>('AGENT_MODEL');
        if (
            !modelId ||
            this.config.get<string>('AGENT_PROVIDER') !== 'lm-studio'
        ) {
            return Promise.resolve(false);
        }
        return this.thinking.isAvailable({
            modelId,
            baseURL: this.config.getOrThrow<string>('AGENT_BASE_URL'),
            apiKey: this.config.get<string>('AGENT_API_KEY'),
        });
    }

    private searchActivity(
        part: UIMessageChunk,
        searches: Map<string, SearchActivity>,
    ): SearchActivity | undefined {
        if (
            part.type === 'tool-input-available' &&
            part.toolName === searchToolName
        ) {
            const input = searchInput.safeParse(part.input);
            if (input.success) {
                return {
                    id: part.toolCallId,
                    query: input.data.query,
                    status: 'searching',
                    sources: [],
                };
            }
        }
        if (
            part.type === 'tool-output-available' ||
            part.type === 'tool-output-error'
        ) {
            const previous = searches.get(part.toolCallId);
            if (!previous) return;
            const output = searchOutput.safeParse(
                part.type === 'tool-output-available' ? part.output : null,
            );
            return output.success
                ? {
                      ...previous,
                      ...output.data,
                      status: output.data.error ? 'failed' : 'complete',
                  }
                : {
                      ...previous,
                      status: 'failed',
                      error: 'Web search failed.',
                  };
        }
    }
}
