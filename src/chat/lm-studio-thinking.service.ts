import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

export const lmStudioResponsesModel = 'lmStudioResponses';

export function lmStudioModelsUrl(baseURL: string) {
    const url = new URL(baseURL);
    const prefix = url.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '');
    url.pathname = prefix + '/api/v1/models';
    url.search = '';
    url.hash = '';
    return url;
}

const modelListSchema = z.object({
    models: z.array(
        z.object({
            key: z.string(),
            loaded_instances: z.array(z.object({ id: z.string() })).nullish(),
            capabilities: z
                .object({
                    reasoning: z
                        .object({ allowed_options: z.array(z.string()) })
                        .nullish(),
                })
                .nullish(),
        }),
    ),
});

export type LmStudioConnection = {
    baseURL: string;
    modelId: string;
    apiKey?: string;
};

@Injectable()
export class LmStudioThinkingService {
    private check?: {
        model: string;
        expiresAt: number;
        available: Promise<boolean>;
    };

    constructor(private readonly config: ConfigService) {}

    async isAvailable(connection?: LmStudioConnection): Promise<boolean> {
        if (!connection) {
            if (this.config.get<string>('AI_PROVIDER') !== 'lm-studio') {
                return false;
            }
            connection = {
                baseURL: this.config.getOrThrow<string>('AI_BASE_URL'),
                modelId: this.config.getOrThrow<string>('AI_MODEL'),
                apiKey: this.config.get<string>('AI_API_KEY'),
            };
        }
        const model = JSON.stringify([connection.baseURL, connection.modelId]);
        if (
            !this.check ||
            this.check.model !== model ||
            this.check.expiresAt <= Date.now()
        ) {
            this.check = {
                model,
                expiresAt: Date.now() + 15_000,
                available: this.checkModel(connection),
            };
        }
        return this.check.available;
    }

    private async checkModel({
        baseURL,
        modelId,
        apiKey,
    }: LmStudioConnection): Promise<boolean> {
        try {
            const response = await fetch(lmStudioModelsUrl(baseURL), {
                headers: apiKey
                    ? { Authorization: `Bearer ${apiKey}` }
                    : undefined,
                signal: AbortSignal.timeout(2000),
            });
            if (!response.ok) {
                return false;
            }
            const result = modelListSchema.safeParse(await response.json());
            if (!result.success) {
                return false;
            }
            const model = result.data.models.find(
                ({ key, loaded_instances }) =>
                    key === modelId ||
                    loaded_instances?.some(
                        (instance) => instance.id === modelId,
                    ),
            );
            const options = model?.capabilities?.reasoning?.allowed_options;
            return Boolean(options?.includes('on') && options.includes('off'));
        } catch {
            return false;
        }
    }
}
