import { ConfigService } from '@nestjs/config';
import { DeepSeekSearchProvider } from './agent-search.js';

afterEach(() => vi.restoreAllMocks());

describe('DeepSeek search provider', () => {
    it('uses the standalone endpoint and returns normalized HTTP sources', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            Response.json({
                results: [
                    {
                        title: 'Example',
                        url: 'https://example.com/',
                        summary: 'Details',
                        snippet: 'Short',
                    },
                    {
                        title: 'Unsupported link',
                        url: 'javascript:alert(0)',
                        summary: 'Invalid result',
                    },
                ],
            }),
        );
        const provider = new DeepSeekSearchProvider(
            new ConfigService({ DEEPSEEK_SEARCH_API_KEY: 'test-key' }),
        );
        await expect(
            provider.search('example', new AbortController().signal),
        ).resolves.toEqual({
            sources: [
                {
                    title: 'Example',
                    url: 'https://example.com/',
                    summary: 'Details',
                },
            ],
        });
        expect(fetch).toHaveBeenCalledWith(
            'https://api.deepseek.com/v1/tools/search',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-key',
                }),
                body: JSON.stringify({
                    query: 'example',
                    count: 5,
                    need_content: false,
                }),
            }),
        );
    });
});
