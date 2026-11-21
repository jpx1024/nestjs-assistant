import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: { tsconfigPaths: true },
    test: {
        globals: true,
        root: './',
        include: ['**/*.e2e-spec.ts'],
        env: {
            AI_PROVIDER: 'lm-studio',
            LM_STUDIO_MODEL: 'test-model',
            CHAT_DB_PATH: ':memory:',
        },
    },
});
