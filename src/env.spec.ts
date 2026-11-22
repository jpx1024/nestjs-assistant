import { validateEnv } from './env.js';

describe('validateEnv', () => {
    it('defaults to LM Studio and uses only its configuration', () => {
        expect(
            validateEnv({
                LM_STUDIO_MODEL: 'local-chat',
                OPENAI_BASE_URL: 'invalid unused URL',
                OPENAI_API_KEY: 'unused-key',
            }),
        ).toMatchObject({
            AI_PROVIDER: 'lm-studio',
            AI_BASE_URL: 'http://127.0.0.1:1234/v1',
            AI_MODEL: 'local-chat',
            AI_API_KEY: undefined,
            AI_PROJECT_NAME: 'nestjs-assistant',
            AI_TIME_ZONE: 'Asia/Shanghai',
            DB_PATH: 'data/assistant.sqlite',
            AI_INCLUDE_STREAM_USAGE: true,
            PORT: 3000,
        });
    });

    it('switches the selected model and credentials to OpenAI', () => {
        expect(
            validateEnv({
                AI_PROVIDER: 'openai',
                OPENAI_MODEL: 'openai-chat',
                OPENAI_API_KEY: 'test-key',
                AI_TIMEOUT_MS: '5000',
                AI_INCLUDE_STREAM_USAGE: 'false',
            }),
        ).toMatchObject({
            AI_PROVIDER: 'openai',
            AI_BASE_URL: 'https://api.openai.com/v1',
            AI_MODEL: 'openai-chat',
            AI_API_KEY: 'test-key',
            AI_TIMEOUT_MS: 5000,
            AI_INCLUDE_STREAM_USAGE: false,
        });
    });

    it('reports missing credentials and rejects an invalid local base URL', () => {
        expect(() => validateEnv({ AI_PROVIDER: 'openai' })).toThrow(
            'OPENAI_MODEL, OPENAI_API_KEY',
        );
        expect(() =>
            validateEnv({
                LM_STUDIO_BASE_URL: 'file:///tmp/server',
                LM_STUDIO_MODEL: 'local-chat',
            }),
        ).toThrow('LM_STUDIO_BASE_URL');
    });

    it('rejects an invalid system prompt time zone', () => {
        expect(() =>
            validateEnv({
                LM_STUDIO_MODEL: 'local-chat',
                AI_TIME_ZONE: 'invalid/time-zone',
            }),
        ).toThrow('AI_TIME_ZONE');
    });

    it('parses the optional SQLite schema synchronization flag', () => {
        expect(
            validateEnv({
                LM_STUDIO_MODEL: 'local-chat',
                DB_SYNCHRONIZE: 'false',
            }),
        ).toMatchObject({ DB_SYNCHRONIZE: false });
        expect(
            validateEnv({
                LM_STUDIO_MODEL: 'local-chat',
                DB_SYNCHRONIZE: 'true',
            }),
        ).toMatchObject({ DB_SYNCHRONIZE: true });
    });

    it('resolves the explicit Agent model connection separately from Chat', () => {
        expect(
            validateEnv({
                LM_STUDIO_MODEL: 'chat-model',
                AGENT_PROVIDER: 'openai',
                AGENT_MODEL: 'agent-model',
                AGENT_BASE_URL: 'https://agent.example.com/v1',
                AGENT_API_KEY: 'agent-key',
            }),
        ).toMatchObject({
            AI_MODEL: 'chat-model',
            AI_BASE_URL: 'http://127.0.0.1:1234/v1',
            AGENT_MODEL: 'agent-model',
            AGENT_BASE_URL: 'https://agent.example.com/v1',
            AGENT_API_KEY: 'agent-key',
        });
    });
});
