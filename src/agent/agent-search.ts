import { AgentFunction, type AgentFunctionContext } from '@nestjs/ai';
import { Injectable, Module } from '@nestjs/common';
import { z } from 'zod';
import {
    maxSearchQueryLength,
    type SearchResult,
    WebSearchModule,
    WebSearchProvider,
} from '../search/web-search.js';

export const searchToolName = 'web_search';
export const searchInput = z.object({
    query: z
        .string()
        .trim()
        .min(1)
        .refine(
            (query) => Array.from(query).length <= maxSearchQueryLength,
            `Search queries can contain at most ${maxSearchQueryLength} characters.`,
        )
        .describe('Keywords to look up on the public web.'),
});

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
            return { sources: [], error: 'Search limit reached for this run.' };
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

@Module({ imports: [WebSearchModule], providers: [AgentSearchTool] })
export class AgentToolsModule {}
