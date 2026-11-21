import { AiModule } from '@nestjs/ai';
import { FakeModel } from '@nestjs/ai/testing';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AgentModule } from '../src/agent/agent.module.js';
import { AgentToolsModule } from '../src/agent/agent-search.js';
import {
    type SearchResult,
    WebSearchProvider,
} from '../src/search/web-search.js';
import { agentModelName } from '../src/agent/agent.service.js';
import { LmStudioThinkingService } from '../src/chat/lm-studio-thinking.service.js';
import { ConversationsModule } from '../src/conversations/conversations.module.js';

describe('Agent workspace (e2e)', () => {
    let app: INestApplication<App>;
    let baseUrl: string;
    const chat = new FakeModel([]);
    const model = new FakeModel([]);
    const api = '/api/agent/conversations';
    const result: SearchResult = {
        sources: [
            {
                title: 'Reference',
                url: 'https://example.com/agent',
                summary: 'Reference code XE-71.',
            },
        ],
    };
    const search = vi
        .fn<(query: string, signal: AbortSignal) => Promise<SearchResult>>()
        .mockResolvedValue(result);

    beforeAll(async () => {
        const module = await Test.createTestingModule({
            imports: [
                ConfigModule.forRoot({
                    isGlobal: true,
                    ignoreEnvFile: true,
                    load: [
                        () => ({
                            DB_PATH: ':memory:',
                            AI_PROJECT_NAME: 'Agent E2E',
                            AI_TIME_ZONE: 'Asia/Shanghai',
                            AGENT_PROVIDER: 'lm-studio',
                            AGENT_BASE_URL: 'http://127.0.0.1:1234/v1',
                            AGENT_MODEL: 'unit-test-agent',
                            AGENT_TIMEOUT_MS: 4000,
                            AGENT_MAX_STEPS: 4,
                            AGENT_MAX_OUTPUT_TOKENS: 1024,
                            AGENT_DEEP_MAX_OUTPUT_TOKENS: 2048,
                            AGENT_SEARCH_PROVIDER: 'deepseek',
                            DEEPSEEK_SEARCH_API_KEY: 'test-key',
                        }),
                    ],
                }),
                AiModule.forRoot({
                    isGlobal: true,
                    include: [AgentToolsModule],
                    models: { default: chat, [agentModelName]: model },
                    defaults: { retry: false },
                }),
                AgentModule,
                AgentToolsModule,
                ConversationsModule,
            ],
        })
            .overrideProvider(WebSearchProvider)
            .useValue({ search })
            .overrideProvider(LmStudioThinkingService)
            .useValue({ isAvailable: async () => true })
            .compile();
        app = module.createNestApplication<INestApplication<App>>();
        await app.listen(0, '127.0.0.1');
        baseUrl = await app.getUrl();
    });

    afterAll(async () => {
        await app?.close();
    });

    async function create(path = api) {
        const response = await request(app.getHttpServer())
            .post(path)
            .expect(201);
        return (response.body as { id: string }).id;
    }

    it('keeps Chat separate and streams, saves and reuses the results of a model-selected search', async () => {
        const chatId = await create('/api/conversations');
        const agentId = await create();
        const url = `${api}/${agentId}`;
        await request(app.getHttpServer()).get(`${api}/${chatId}`).expect(404);
        await request(app.getHttpServer())
            .get(`/api/conversations/${agentId}`)
            .expect(404);
        for (const [base, otherId] of [
            [api, chatId],
            ['/api/conversations', agentId],
        ]) {
            const other = `${base}/${otherId}`;
            await request(app.getHttpServer())
                .get(base)
                .expect(200)
                .expect(({ body }) => {
                    expect(body).not.toContainEqual(
                        expect.objectContaining({ id: otherId }),
                    );
                });
            await request(app.getHttpServer())
                .patch(other)
                .send({ title: 'Cross-workspace rename' })
                .expect(404);
            await request(app.getHttpServer()).delete(other).expect(404);
            await request(app.getHttpServer())
                .post(`${other}/messages`)
                .send({ content: 'Cross-workspace send' })
                .expect(404);
            await request(app.getHttpServer())
                .post(`${other}/messages/retry`)
                .expect(404);
        }
        await request(app.getHttpServer())
            .get('/api/agent/model')
            .expect(200)
            .expect({
                provider: 'lm-studio',
                model: 'unit-test-agent',
                modelAvailable: true,
                searchAvailable: true,
                thinkingAvailable: true,
            });
        model.reply(
            {
                toolCalls: [
                    { name: 'web_search', input: { query: 'reference code' } },
                ],
            },
            'The code is XE-71.',
        );
        const reply = await request(app.getHttpServer())
            .post(url + '/messages')
            .send({ content: 'Find the reference code.', thinking: false })
            .expect(200);
        expect(reply.text).toContain('"type":"data-agent-search"');
        expect(reply.text).toContain('"status":"searching"');
        expect(reply.text).toContain('"status":"complete"');
        expect(reply.text).toContain('https://example.com/agent');
        expect(reply.text).toContain('"type":"finish"');
        expect(chat.calls).toHaveLength(0);
        expect(search).toHaveBeenCalledWith(
            'reference code',
            expect.any(AbortSignal),
        );
        const saved = await request(app.getHttpServer()).get(url).expect(200);
        expect(saved.body).toMatchObject({
            messages: [
                { role: 'user', thinking: false },
                {
                    role: 'assistant',
                    content: 'The code is XE-71.',
                    searches: [
                        {
                            query: 'reference code',
                            status: 'complete',
                            sources: result.sources,
                        },
                    ],
                },
            ],
        });
        model.reply('According to the previous source, it is XE-71.');
        await request(app.getHttpServer())
            .post(url + '/messages')
            .send({ content: 'What did the previous source say?' })
            .expect(200)
            .expect(/"type":"finish"/);
        expect(JSON.stringify(model.lastCall?.options.prompt)).toContain(
            result.sources[0].summary,
        );
        expect(model.lastCall?.instructions).toContain('Agent E2E');
        expect(model.lastCall?.instructions).toContain('网页搜索');
    });

    it('cancels an in-flight search on disconnect and retries in the original thinking mode', async () => {
        const url = `${api}/${await create()}`;
        let canceled = false;
        search.mockImplementationOnce(
            (_query, signal) =>
                new Promise((_, reject) => {
                    signal.addEventListener(
                        'abort',
                        () => {
                            canceled = true;
                            reject(signal.reason);
                        },
                        { once: true },
                    );
                }),
        );
        model.reply({
            toolCalls: [
                { name: 'web_search', input: { query: 'slow search' } },
            ],
        });
        const client = new AbortController();
        const response = await fetch(baseUrl + url + '/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: 'Search and wait.',
                thinking: true,
            }),
            signal: AbortSignal.any([client.signal, AbortSignal.timeout(2000)]),
        });
        const reader = response
            .body!.pipeThrough(new TextDecoderStream())
            .getReader();
        let trace = '';
        try {
            while (!trace.includes('"status":"searching"')) {
                const part = await reader.read();
                if (part.done)
                    throw new Error(
                        'Agent stream ended before search started.',
                    );
                trace += part.value;
            }
        } finally {
            client.abort();
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
        await vi.waitFor(async () => {
            expect(canceled).toBe(true);
            const stopped = await request(app.getHttpServer())
                .get(url)
                .expect(200);
            expect(stopped.body).toMatchObject({
                messages: [
                    { role: 'user', thinking: true },
                    { status: 'stopped', searches: [{ status: 'stopped' }] },
                ],
            });
        });
        model.reply('Retry completed.');
        await request(app.getHttpServer())
            .post(url + '/messages/retry')
            .expect(200)
            .expect(/"type":"finish"/);
        expect(model.lastCall?.options.providerOptions?.openai).toMatchObject({
            reasoningEffort: 'high',
        });
        const saved = await request(app.getHttpServer()).get(url).expect(200);
        expect(saved.body).toMatchObject({
            messages: [
                { role: 'user', content: 'Search and wait.' },
                { status: 'complete', content: 'Retry completed.' },
            ],
        });
    });
});
