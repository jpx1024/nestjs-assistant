import { AiService } from '@nestjs/ai';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    createUIMessageStreamResponse,
    type ModelMessage,
    type UIMessageChunk,
} from 'ai';
import {
    LmStudioThinkingService,
    lmStudioResponsesModel,
} from './lm-studio-thinking.service.js';
import { PromptService } from './prompt.service.js';

export type ReplyOutcome = {
    content: string;
    status: 'complete' | 'stopped' | 'failed';
};

type StreamOptions = {
    thinking?: boolean;
    onSettled?: (outcome: ReplyOutcome) => Promise<void>;
};

@Injectable()
export class ChatService {
    private readonly logger = new Logger(ChatService.name);

    constructor(
        private readonly ai: AiService,
        private readonly config: ConfigService,
        private readonly prompts: PromptService,
        private readonly thinking: LmStudioThinkingService,
    ) {}

    async model() {
        return {
            provider: this.config.getOrThrow<string>('AI_PROVIDER'),
            model: this.config.getOrThrow<string>('AI_MODEL'),
            thinkingAvailable: await this.thinking.isAvailable(),
        };
    }

    async stream(
        messages: ModelMessage[],
        clientSignal: AbortSignal,
        { thinking, onSettled }: StreamOptions = {},
    ): Promise<Response> {
        if (thinking !== undefined && !(await this.thinking.isAvailable())) {
            throw new BadRequestException(
                'The configured model cannot switch thinking modes.',
            );
        }
        const timeout = AbortSignal.timeout(
            this.config.getOrThrow<number>(
                thinking ? 'AI_DEEP_TIMEOUT_MS' : 'AI_TIMEOUT_MS',
            ),
        );
        const maxOutputTokens =
            thinking === undefined
                ? undefined
                : this.config.getOrThrow<number>(
                      thinking
                          ? 'AI_DEEP_MAX_OUTPUT_TOKENS'
                          : 'AI_MAX_OUTPUT_TOKENS',
                  );
        const answer = this.ai.streamText({
            instructions: this.prompts.renderSystemPrompt(),
            messages,
            abortSignal: AbortSignal.any([clientSignal, timeout]),
            maxOutputTokens,
            ...(thinking !== undefined && {
                model: lmStudioResponsesModel,
                providerOptions: {
                    openai: {
                        forceReasoning: true,
                        systemMessageMode: 'system',
                        reasoningEffort: thinking ? 'high' : 'none',
                        reasoningSummary: null,
                        store: false,
                    },
                },
            }),
        });
        const errorText = () =>
            timeout.aborted
                ? 'The model took too long to respond.'
                : 'The model is unavailable or the response failed.';
        if (!onSettled && thinking === undefined) {
            return answer.toUIMessageStreamResponse({ errorText });
        }

        let content = '';
        let settlement: Promise<boolean> | undefined;
        const save = async (status: ReplyOutcome['status']) => {
            clientSignal.removeEventListener('abort', stop);
            try {
                await onSettled?.({ content, status });
                return true;
            } catch (error) {
                this.logger.error(
                    'Could not save the conversation reply',
                    error,
                );
                return false;
            }
        };
        const settle = (status: ReplyOutcome['status']) =>
            (settlement ??= save(status));
        const stop = () => {
            void settle('stopped');
        };
        clientSignal.addEventListener('abort', stop, { once: true });
        if (clientSignal.aborted) {
            stop();
        }

        const stream = answer.toUIMessageStream({ errorText }).pipeThrough(
            new TransformStream<UIMessageChunk, UIMessageChunk>({
                async transform(part, controller) {
                    if (thinking === false && part.type === 'reasoning-delta') {
                        return;
                    }
                    if (part.type === 'text-delta') {
                        content += part.delta;
                    }
                    if (
                        part.type === 'finish' &&
                        maxOutputTokens !== undefined
                    ) {
                        const empty = !content.trim();
                        // LM Studio can report completion with only reasoning and one token left.
                        const reachedLimit =
                            part.finishReason === 'length' ||
                            (empty &&
                                (await answer.usage).outputTokens >=
                                    Math.max(1, maxOutputTokens - 1));
                        if (reachedLimit || empty) {
                            const message = reachedLimit
                                ? 'The model reached the output token limit.'
                                : 'The model ended without a text answer.';
                            controller.enqueue({
                                type: 'error',
                                errorText: (await settle('failed'))
                                    ? message
                                    : 'The reply could not be saved.',
                            });
                            return;
                        }
                    }
                    if (part.type === 'finish' || part.type === 'error') {
                        const saved = await settle(
                            part.type === 'finish' ? 'complete' : 'failed',
                        );
                        if (!saved) {
                            controller.enqueue({
                                type: 'error',
                                errorText: 'The reply could not be saved.',
                            });
                            return;
                        }
                    }
                    controller.enqueue(part);
                },
                async flush(controller) {
                    if (!settlement) {
                        await settle('failed');
                        controller.enqueue({
                            type: 'error',
                            errorText: errorText(),
                        });
                    }
                },
            }),
        );
        return createUIMessageStreamResponse({ stream, keepAliveMs: 15_000 });
    }
}
