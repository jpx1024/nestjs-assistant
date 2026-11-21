import { AgentFunction, type AgentFunctionContext } from '@nestjs/ai';
import { Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

export const searchToolName = 'web_search';
export const searchInput = z.object({
    query: z
        .string()
        .trim()
        .min(1)
        .refine(
            (query) => Array.from(query).length <= 128,
            'Search queries can contain at most 128 characters.',
        )
        .describe('Keywords to look up on the public web.'),
});

const sourceSchema = z.object({
    title: z.string(),
    url: z.url({ protocol: /^https?$/ }),
    summary: z.string(),
});

export const searchOutput = z.object({
    sources: z.array(sourceSchema),
    error: z.string().optional(),
});

export type SearchResult = z.infer<typeof searchOutput>;
export type SearchActivity = SearchResult & {
    id: string;
    query: string;
    status: 'searching' | 'complete' | 'failed' | 'stopped';
};

export abstract class WebSearchProvider {
    abstract search(query: string, signal: AbortSignal): Promise<SearchResult>;
}

@Injectable()
export class DeepSeekSearchProvider implements WebSearchProvider {
    constructor(private readonly config: ConfigService) {}

    async search(query: string, signal: AbortSignal): Promise<SearchResult> {
        const key = this.config.get<string>('DEEPSEEK_SEARCH_API_KEY');
        if (!key) {
            return { sources: [], error: 'Web search is not configured.' };
        }
        try {
            const response = await fetch(
                'https://api.deepseek.com/v1/tools/search',
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${key}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        query,
                        count: 5,
                        need_content: false,
                    }),
                    signal: AbortSignal.any([
                        signal,
                        AbortSignal.timeout(15_000),
                    ]),
                },
            );
            if (!response.ok) {
                return {
                    sources: [],
                    error: `DeepSeek search returned HTTP ${response.status}.`,
                };
            }
            const data = z
                .object({ results: z.array(z.unknown()) })
                .parse(await response.json());
            const sources: SearchResult['sources'] = [];
            for (const item of data.results.slice(0, 5)) {
                const parsed = sourceSchema.safeParse(item);
                if (parsed.success) {
                    sources.push({
                        title: parsed.data.title.slice(0, 300),
                        url: parsed.data.url,
                        summary: parsed.data.summary.slice(0, 1800),
                    });
                }
            }
            return { sources };
        } catch {
            signal.throwIfAborted();
            return {
                sources: [],
                error: 'DeepSeek search failed or timed out.',
            };
        }
    }
}

export type AgentRunBudget = { searchesRemaining: number };

@Injectable()
class AgentSearchTool {
    constructor(private readonly provider: WebSearchProvider) {}

    @AgentFunction({
        name: searchToolName,
        description:
            'Search public web pages for up-to-date information and sources.',
        inputSchema: searchInput,
    })
    async search(
        { query }: z.infer<typeof searchInput>,
        context: AgentFunctionContext<unknown, AgentRunBudget>,
    ): Promise<SearchResult> {
        if (!context.user || context.user.searchesRemaining <= 0) {
            return {
                sources: [],
                error: 'Search limit reached for this run.',
            };
        }
        context.user.searchesRemaining--;
        try {
            return await this.provider.search(query, context.signal);
        } catch (error) {
            if (context.signal.aborted) {
                return { sources: [], error: 'Search canceled.' };
            }
            throw error;
        }
    }
}

@Module({
    providers: [
        { provide: WebSearchProvider, useClass: DeepSeekSearchProvider },
        AgentSearchTool,
    ],
})
export class AgentToolsModule {}
