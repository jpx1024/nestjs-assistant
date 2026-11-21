import { Injectable, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { z } from 'zod';

export const maxSearchQueryLength = 128;

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

@Module({
    imports: [ConfigModule],
    providers: [
        { provide: WebSearchProvider, useClass: DeepSeekSearchProvider },
    ],
    exports: [WebSearchProvider],
})
export class WebSearchModule {}
