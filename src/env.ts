import { z } from 'zod';

const timeZoneSchema = z
    .string()
    .trim()
    .refine((timeZone) => {
        try {
            new Intl.DateTimeFormat('zh-CN', { timeZone });
            return true;
        } catch {
            return false;
        }
    });

const commonSchema = z.object({
    HOST: z.string().trim().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    AI_PROVIDER: z.enum(['lm-studio', 'openai']).default('lm-studio'),
    AI_PROJECT_NAME: z.string().trim().min(1).default('nestjs-assistant'),
    AI_TIME_ZONE: timeZoneSchema.default('Asia/Shanghai'),
    DB_PATH: z.string().trim().min(1).default('data/assistant.sqlite'),
    DB_SYNCHRONIZE: z.stringbool().optional(),
    DEEPSEEK_SEARCH_API_KEY: z.string().trim().optional(),
    AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),
    AI_INCLUDE_STREAM_USAGE: z.stringbool().default(true),
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1024),
    AI_DEEP_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(4096),
    AI_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(1)
        .max(2_147_483_647)
        .default(120_000),
    AI_DEEP_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(1)
        .max(2_147_483_647)
        .default(240_000),
});

const baseUrl = z.url({ protocol: /^https?$/ });
const nonEmpty = z.string().trim().min(1);

const agentSchema = z.object({
    AGENT_PROVIDER: z.enum(['lm-studio', 'openai']).default('lm-studio'),
    AGENT_MODEL: z.string().trim().optional(),
    AGENT_BASE_URL: z.union([baseUrl, z.literal('')]).optional(),
    AGENT_API_KEY: z.string().trim().optional(),
    AGENT_MAX_STEPS: z.coerce.number().int().min(2).max(12).default(4),
    AGENT_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(1)
        .max(2_147_483_647)
        .default(180_000),
    AGENT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(2048),
    AGENT_DEEP_MAX_OUTPUT_TOKENS: z.coerce
        .number()
        .int()
        .positive()
        .default(4096),
    AGENT_SEARCH_PROVIDER: z.literal('deepseek').default('deepseek'),
});

const lmStudioSchema = z.object({
    LM_STUDIO_BASE_URL: baseUrl.default('http://127.0.0.1:1234/v1'),
    LM_STUDIO_MODEL: nonEmpty,
    LM_STUDIO_API_KEY: z.string().trim().optional(),
});

const openAiSchema = z.object({
    OPENAI_BASE_URL: baseUrl.default('https://api.openai.com/v1'),
    OPENAI_MODEL: nonEmpty,
    OPENAI_API_KEY: nonEmpty,
});

function parseEnv<T>(schema: z.ZodType<T>, env: Record<string, unknown>): T {
    const result = schema.safeParse(env);
    if (!result.success) {
        const fields = result.error.issues.map(({ path }) => path.join('.'));
        throw new Error(
            `Missing or invalid environment variables: ${fields.join(', ')}`,
        );
    }
    return result.data;
}

function chatConnection(
    env: Record<string, unknown>,
    provider: 'lm-studio' | 'openai',
) {
    if (provider === 'openai') {
        const openai = parseEnv(openAiSchema, env);
        return {
            AI_BASE_URL: openai.OPENAI_BASE_URL,
            AI_MODEL: openai.OPENAI_MODEL,
            AI_API_KEY: openai.OPENAI_API_KEY,
        };
    }
    const lmStudio = parseEnv(lmStudioSchema, env);
    return {
        AI_BASE_URL: lmStudio.LM_STUDIO_BASE_URL,
        AI_MODEL: lmStudio.LM_STUDIO_MODEL,
        AI_API_KEY: lmStudio.LM_STUDIO_API_KEY || undefined,
    };
}

export function validateEnv(env: Record<string, unknown>) {
    const common = parseEnv(commonSchema, env);
    const chat = chatConnection(env, common.AI_PROVIDER);
    const agent = parseEnv(agentSchema, env);
    const agentLmStudio = agent.AGENT_PROVIDER === 'lm-studio';
    if (!agent.AGENT_MODEL) {
        return { ...env, ...common, ...chat, ...agent };
    }
    const connection = parseEnv(
        z.object({
            AGENT_BASE_URL: baseUrl,
            AGENT_API_KEY: z.string().trim().optional(),
        }),
        {
            AGENT_BASE_URL:
                agent.AGENT_BASE_URL ||
                (agentLmStudio
                    ? env.LM_STUDIO_BASE_URL
                    : env.OPENAI_BASE_URL) ||
                (agentLmStudio
                    ? 'http://127.0.0.1:1234/v1'
                    : 'https://api.openai.com/v1'),
            AGENT_API_KEY:
                agent.AGENT_API_KEY ||
                (agentLmStudio ? env.LM_STUDIO_API_KEY : env.OPENAI_API_KEY),
        },
    );
    return { ...env, ...common, ...chat, ...agent, ...connection };
}
