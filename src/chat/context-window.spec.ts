import { ConfigService } from '@nestjs/config';
import { ContextWindowService } from './context-window.js';

afterEach(() => vi.restoreAllMocks());

it('uses the loaded LM Studio instance capacity and leaves other model capacity unknown without a setting', async () => {
    const fetchModels = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({
            models: [
                {
                    key: 'test-model',
                    max_context_length: 131072,
                    loaded_instances: [
                        { id: 'chat-local', config: { context_length: 8192 } },
                    ],
                },
            ],
        }),
    );
    const context = new ContextWindowService(
        new ConfigService({
            AI_PROVIDER: 'lm-studio',
            AI_BASE_URL: 'http://127.0.0.1:1234/v1',
            AI_MODEL: 'chat-local',
            AI_CONTEXT_WINDOW_TOKENS: 4096,
            AGENT_PROVIDER: 'openai',
        }),
    );
    const preview = await context.preview('chat', 'Answer clearly.', [], {
        draft: '一个问题',
        webSearch: true,
    });
    expect(preview).toMatchObject({
        windowTokens: 8192,
        reservedOutputTokens: 1024,
        pendingSearch: true,
    });
    expect(preview.remainingTokens).toBe(8192 - 1024 - preview.inputTokens);
    expect(fetchModels.mock.calls[0][0]).toMatchObject({
        href: 'http://127.0.0.1:1234/api/v1/models',
    });
    await context.preview('chat', 'Answer clearly.', [], {
        draft: 'Another question',
    });
    expect(fetchModels).toHaveBeenCalledTimes(1);
    await expect(
        context.preview('agent', 'Answer clearly.', [], { draft: '' }),
    ).resolves.toMatchObject({
        windowTokens: null,
        remainingTokens: null,
    });
});
