import { AiModule } from '@nestjs/ai';
import { FakeModel, providerError } from '@nestjs/ai/testing';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { UIMessageChunk } from 'ai';
import { ChatModule } from '../src/chat/chat.module.js';
import {
    LmStudioThinkingService,
    lmStudioResponsesModel,
} from '../src/chat/lm-studio-thinking.service.js';
import { WebSearchProvider } from '../src/search/web-search.js';

async function* readEvents(response: Response) {
    const reader = response
        .body!.pipeThrough(new TextDecoderStream())
        .getReader();
    let buffer = '';

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                return;
            }

            buffer += value;
            const events = buffer.split('\n\n');
            buffer = events.pop()!;
            for (const event of events) {
                if (event.startsWith('data: {')) {
                    yield JSON.parse(
                        event.slice('data: '.length),
                    ) as UIMessageChunk;
                }
            }
        }
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }
}

async function collectEvents(response: Response) {
    const events: UIMessageChunk[] = [];
    for await (const event of readEvents(response)) {
        events.push(event);
    }
    return events;
}

describe('POST /api/chat/stream (e2e)', () => {
    let app: INestApplication;
    let model: FakeModel;
    let baseUrl: string;
    const search = vi.fn().mockResolvedValue({ sources: [] });

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
                            AI_MAX_OUTPUT_TOKENS: 1024,
                            AI_DEEP_TIMEOUT_MS: 10_000,
                            AI_DEEP_MAX_OUTPUT_TOKENS: 4000,
                            AI_PROJECT_NAME: 'Direct Chat Test',
                            AI_TIME_ZONE: 'Asia/Shanghai',
                            DEEPSEEK_SEARCH_API_KEY: 'test-key',
                        }),
                    ],
                }),
                AiModule.forRoot({
                    isGlobal: true,
                    models: { default: model, [lmStudioResponsesModel]: model },
                    defaults: { retry: false },
                }),
                ChatModule,
            ],
        })
            .overrideProvider(WebSearchProvider)
            .useValue({ search })
            .compile();
        app = module.createNestApplication();
        await app.listen(0, '127.0.0.1');
        baseUrl = await app.getUrl();
    });

    afterAll(async () => {
        await app?.close();
    });

    function send(
        messages: unknown = [{ role: 'user', content: 'Say hello' }],
        signal?: AbortSignal,
        thinking?: boolean,
        webSearch?: boolean,
    ) {
        return fetch(`${baseUrl}/api/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages, thinking, webSearch }),
            signal,
        });
    }

    it('validates the request before calling the model', async () => {
        const response = await send([{ role: 'user', content: '  ' }]);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ statusCode: 400 });
        expect(model.calls).toHaveLength(0);
    });

    it('streams text deltas and a finish event', async () => {
        model.reply({ text: 'Hello from the model', chunkDelay: 40 });

        const response = await send();
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toContain(
            'text/event-stream',
        );

        const deltas: string[] = [];
        const events: string[] = [];
        for await (const event of readEvents(response)) {
            events.push(event.type);
            if (event.type === 'text-delta') {
                deltas.push(event.delta);
            }
        }
        expect(deltas.length).toBeGreaterThan(1);
        expect(deltas.join('')).toBe('Hello from the model');
        expect(events.at(-1)).toBe('finish');
        expect(model.lastCall?.instructions).toContain(
            '项目名称：Direct Chat Test',
        );
    });

    it('uses the latest user question as a bounded query in the direct stream', async () => {
        model.reply('No matching sources were found.');
        const question = '🔎'.repeat(129) + ' not part of the search query';
        const response = await send(
            [
                { role: 'user', content: 'Previous question' },
                { role: 'assistant', content: 'Previous reply' },
                { role: 'user', content: question },
            ],
            undefined,
            undefined,
            true,
        );
        expect(response.status).toBe(200);
        const events = await collectEvents(response);
        expect(events.at(0)).toMatchObject({
            type: 'data-chat-search',
            data: { status: 'searching' },
        });
        expect(events.at(1)).toMatchObject({
            type: 'data-chat-search',
            data: { status: 'complete', sources: [] },
        });
        expect(events.at(-1)?.type).toBe('finish');
        expect(search).toHaveBeenCalledExactlyOnceWith(
            '🔎'.repeat(128),
            expect.any(AbortSignal),
        );
        expect(JSON.stringify(model.lastCall?.options.prompt)).toContain(
            'not part of the search query',
        );
    });

    it('returns a public SSE error when the model is unavailable', async () => {
        model.reply(
            providerError(503, { message: 'private upstream details' }),
        );
        const events = await collectEvents(await send());
        expect(events).toContainEqual({
            type: 'error',
            errorText: 'The model is unavailable or the response failed.',
        });
    });

    it.each([
        { thinking: false, effort: 'none' },
        { thinking: true, effort: 'high' },
    ])(
        'sends Responses effort $effort for an explicit thinking mode',
        async ({ thinking, effort }) => {
            const capability = vi
                .spyOn(app.get(LmStudioThinkingService), 'isAvailable')
                .mockResolvedValue(true);
            model.reply('Hello');
            try {
                const events = await collectEvents(
                    await send(undefined, undefined, thinking),
                );
                expect(events.at(-1)?.type).toBe('finish');
                expect(
                    model.lastCall?.options.providerOptions?.openai,
                ).toMatchObject({
                    reasoningEffort: effort,
                    forceReasoning: true,
                    store: false,
                });
                if (thinking) {
                    expect(model.lastCall?.options.maxOutputTokens).toBe(4000);
                }
            } finally {
                capability.mockRestore();
            }
        },
    );

    it.each([
        ['length', 4000, 'The model reached the output token limit.'],
        ['stop', 3999, 'The model reached the output token limit.'],
        ['stop', 10, 'The model ended without a text answer.'],
    ] as const)(
        'explains an empty thinking response with finish reason %s and %i tokens',
        async (finishReason, outputTokens, errorText) => {
            const capability = vi
                .spyOn(app.get(LmStudioThinkingService), 'isAvailable')
                .mockResolvedValue(true);
            model.reply({
                text: '',
                finishReason,
                usage: { outputTokens, reasoningTokens: outputTokens },
            });
            try {
                const events = await collectEvents(
                    await send(undefined, undefined, true),
                );
                expect(events).toContainEqual({ type: 'error', errorText });
                expect(events.some((event) => event.type === 'finish')).toBe(
                    false,
                );
            } finally {
                capability.mockRestore();
            }
        },
    );

    it('reports the overall timeout and aborts the model', async () => {
        const config = app.get(ConfigService);
        config.set('AI_TIMEOUT_MS', 120);
        model.reply({ text: 'Too slow', delay: 1000 });

        try {
            const events = await collectEvents(await send());
            expect(events).toContainEqual({
                type: 'error',
                errorText: 'The model took too long to respond.',
            });
            expect(model.lastCall?.options.abortSignal?.aborted).toBe(true);
        } finally {
            config.set('AI_TIMEOUT_MS', 5000);
        }
    });

    it('cancels the model when the client closes the stream', async () => {
        model.reply({ text: 'One two three four five', chunkDelay: 200 });
        const client = new AbortController();
        const response = await send(undefined, client.signal);

        for await (const event of readEvents(response)) {
            if (event.type === 'text-delta') {
                break;
            }
        }
        client.abort();

        await vi.waitFor(() =>
            expect(model.lastCall?.options.abortSignal?.aborted).toBe(true),
        );
    });
});
