import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

export const lmStudioResponsesModel = 'lmStudioResponses';

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

@Injectable()
export class LmStudioThinkingService {
    private check?: { expiresAt: number; available: Promise<boolean> };

    constructor(private readonly config: ConfigService) {}

    async isAvailable(): Promise<boolean> {
        if (this.config.get<string>('AI_PROVIDER') !== 'lm-studio') {
            return false;
        }
        if (!this.check || this.check.expiresAt <= Date.now()) {
            this.check = {
                expiresAt: Date.now() + 15_000,
                available: this.checkModel(),
            };
        }
        return this.check.available;
    }

    private async checkModel(): Promise<boolean> {
        const url = new URL(this.config.getOrThrow<string>('AI_BASE_URL'));
        const prefix = url.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '');
        url.pathname = prefix + '/api/v1/models';
        url.search = '';
        url.hash = '';
        const modelId = this.config.getOrThrow<string>('AI_MODEL');
        const key = this.config.get<string>('AI_API_KEY');
        try {
            const response = await fetch(url, {
                headers: key ? { Authorization: `Bearer ${key}` } : undefined,
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
