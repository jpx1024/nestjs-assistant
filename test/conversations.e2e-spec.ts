import { AiModule } from '@nestjs/ai';
import { FakeModel, providerError } from '@nestjs/ai/testing';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { UIMessageChunk } from 'ai';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
    LmStudioThinkingService,
    lmStudioResponsesModel,
} from '../src/chat/lm-studio-thinking.service.js';
import { ConversationsModule } from '../src/conversations/conversations.module.js';

describe('Conversations (e2e)', () => {
    let app: INestApplication<App>;
    let model: FakeModel;
    let baseUrl: string;
    const api = '/api/conversations';

    beforeAll(async () => {
        model = new FakeModel([]);
        const module = await Test.createTestingModule({
            imports: [
                ConfigModule.forRoot({
                    isGlobal: true,
                    ignoreEnvFile: true,
                    load: [
                        () => ({
                            AI_TIMEOUT_MS: 5000,
                            AI_DEEP_TIMEOUT_MS: 10_000,
                            AI_DEEP_MAX_OUTPUT_TOKENS: 4000,
                            AI_PROJECT_NAME: 'Conversation Test',
                            AI_TIME_ZONE: 'Asia/Shanghai',
                            CHAT_DB_PATH: ':memory:',
                        }),
                    ],
                }),
                AiModule.forRoot({
                    isGlobal: true,
                    models: { default: model, [lmStudioResponsesModel]: model },
                    defaults: { retry: false },
                }),
                ConversationsModule,
            ],
        })
            .overrideProvider(LmStudioThinkingService)
            .useValue({ isAvailable: () => Promise.resolve(true) })
            .compile();
        app = module.createNestApplication<INestApplication<App>>();
        await app.listen(0, '127.0.0.1');
        baseUrl = await app.getUrl();
    });

    afterAll(async () => {
        await app?.close();
    });

    async function create() {
        const response = await request(app.getHttpServer())
            .post(api)
            .expect(201);
        return api + '/' + (response.body as { id: string }).id;
    }

    it('saves messages and supports search, rename and deletion', async () => {
        const conversation = await create();
        model.reply('The answer is forty-two.');
        await request(app.getHttpServer())
            .post(conversation + '/messages')
            .send({ content: 'Explain this particular test.' })
            .expect(200)
            .expect(/"type":"finish"/);
        expect(model.lastCall?.instructions).toContain(
            '项目名称：Conversation Test',
        );
        const saved = await request(app.getHttpServer())
            .get(conversation)
            .expect(200);
        expect(saved.body).toMatchObject({
            title: 'Explain this particular test.',
            messages: [
                { role: 'user', content: 'Explain this particular test.' },
                {
                    role: 'assistant',
                    status: 'complete',
                    content: 'The answer is forty-two.',
                },
            ],
        });
        model.reply('Here is the follow-up.');
        await request(app.getHttpServer())
            .post(conversation + '/messages')
            .send({ content: 'And what comes next?' })
            .expect(200)
            .expect(/"type":"finish"/);
        expect(model.lastCall?.options.prompt.map(({ role }) => role)).toEqual([
            'system',
            'user',
            'assistant',
            'user',
        ]);
        await request(app.getHttpServer())
            .patch(conversation)
            .send({ title: 'Renamed conversation' })
            .expect(200);
        const search = await request(app.getHttpServer())
            .get(api)
            .query({ q: 'forty-two' })
            .expect(200);
        expect(search.body).toEqual([
            expect.objectContaining({ title: 'Renamed conversation' }),
        ]);
        await request(app.getHttpServer()).delete(conversation).expect(204);
        await request(app.getHttpServer()).get(conversation).expect(404);
    });

    it('retries a failed reply in the original thinking mode without duplicating the user message', async () => {
        const conversation = await create();
        model.reply(providerError(503), 'Second attempt');
        await request(app.getHttpServer())
            .post(conversation + '/messages')
            .send({ content: 'Please reply.', thinking: true })
            .expect(200)
            .expect(/"type":"error"/);
        const failed = await request(app.getHttpServer())
            .get(conversation)
            .expect(200);
        expect(failed.body).toMatchObject({
            messages: [{ role: 'user', thinking: true }, { status: 'failed' }],
        });
        await request(app.getHttpServer())
            .post(conversation + '/messages/retry')
            .expect(200)
            .expect(/"type":"finish"/);
        expect(model.lastCall?.instructions).toContain(
            '项目名称：Conversation Test',
        );
        expect(model.lastCall?.options.providerOptions?.openai).toMatchObject({
            reasoningEffort: 'high',
        });
        const retried = await request(app.getHttpServer())
            .get(conversation)
            .expect(200);
        expect(retried.body).toMatchObject({
            messages: [
                { role: 'user', content: 'Please reply.', thinking: true },
                {
                    role: 'assistant',
                    status: 'complete',
                    content: 'Second attempt',
                },
            ],
        });
    });

    it('persists partial output after disconnect and rejects overlapping replies', async () => {
        const conversation = await create();
        const client = new AbortController();
        model.reply({ text: 'One two three four five six', chunkDelay: 350 });
        const response = await fetch(baseUrl + conversation + '/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'Count slowly.' }),
            signal: client.signal,
        });
        const reader = response
            .body!.pipeThrough(new TextDecoderStream())
            .getReader();
        let buffer = '';
        try {
            while (!buffer.includes('"type":"text-delta"')) {
                const chunk = await reader.read();
                if (chunk.done)
                    throw new Error('Expected text before stream ended.');
                buffer += chunk.value;
            }
            const firstDelta = buffer
                .split('\n\n')
                .filter((event) => event.startsWith('data: {'))
                .map((event) => JSON.parse(event.slice(6)) as UIMessageChunk)
                .find((event) => event.type === 'text-delta');
            expect(firstDelta).toMatchObject({
                delta: expect.stringContaining('One'),
            });
            await request(app.getHttpServer())
                .post(conversation + '/messages')
                .send({ content: 'Another question.' })
                .expect(409);
        } finally {
            client.abort();
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }

        await vi.waitFor(async () => {
            const saved = await request(app.getHttpServer())
                .get(conversation)
                .expect(200);
            expect(saved.body).toMatchObject({
                messages: [
                    { role: 'user' },
                    {
                        status: 'stopped',
                        content: expect.stringContaining('One'),
                    },
                ],
            });
        });
        expect(model.lastCall?.options.abortSignal?.aborted).toBe(true);
    });
});
