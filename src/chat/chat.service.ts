import { AiService } from '@nestjs/ai';
import {
    BadRequestException,
    Injectable,
    Logger,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    createUIMessageStream,
    createUIMessageStreamResponse,
    type ModelMessage,
    type UIMessageChunk,
} from 'ai';
import {
    type SearchActivity,
    type SearchResult,
    WebSearchProvider,
} from '../search/web-search.js';
import { addSearchContext } from './chat-search.js';
import {
    LmStudioThinkingService,
    lmStudioResponsesModel,
} from './lm-studio-thinking.service.js';
import { PromptService } from './prompt.service.js';

export type ReplyOutcome = {
    content: string;
    status: 'complete' | 'stopped' | 'failed';
    search?: SearchActivity;
};

type StreamOptions = {
    thinking?: boolean;
    search?: SearchActivity;
    onSearch?: (activity: SearchActivity) => Promise<void>;
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
        private readonly webSearch: WebSearchProvider,
    ) {}

    async model() {
        return {
            provider: this.config.getOrThrow<string>('AI_PROVIDER'),
            model: this.config.getOrThrow<string>('AI_MODEL'),
            thinkingAvailable: await this.thinking.isAvailable(),
            searchAvailable: this.searchAvailable(),
        };
    }

    async stream(
        messages: ModelMessage[],
        clientSignal: AbortSignal,
        { thinking, search, onSearch, onSettled }: StreamOptions = {},
    ): Promise<Response> {
        if (search && !this.searchAvailable()) {
            throw new ServiceUnavailableException(
                'Configure DEEPSEEK_SEARCH_API_KEY to use Chat web search.',
            );
        }
        if (thinking !== undefined && !(await this.thinking.isAvailable())) {
            throw new BadRequestException(
                'The configured model cannot switch thinking modes.',
            );
        }
        const maxOutputTokens =
            thinking === undefined
                ? undefined
                : this.config.getOrThrow<number>(
                      thinking
                          ? 'AI_DEEP_MAX_OUTPUT_TOKENS'
                          : 'AI_MAX_OUTPUT_TOKENS',
                  );
        const startModel = (context: ModelMessage[]) => {
            const timeout = AbortSignal.timeout(
                this.config.getOrThrow<number>(
                    thinking ? 'AI_DEEP_TIMEOUT_MS' : 'AI_TIMEOUT_MS',
                ),
            );
            const answer = this.ai.streamText({
                instructions: this.prompts.renderSystemPrompt(
                    undefined,
                    Boolean(search),
                ),
                messages: context,
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
            return {
                answer,
                errorText: () =>
                    timeout.aborted
                        ? 'The model took too long to respond.'
                        : 'The model is unavailable or the response failed.',
            };
        };
        if (!onSettled && thinking === undefined && !search) {
            const { answer, errorText } = startModel(messages);
            return answer.toUIMessageStreamResponse({ errorText });
        }

        let content = '';
        let activity = search;
        let settlement: Promise<boolean> | undefined;
        const save = async (status: ReplyOutcome['status']) => {
            clientSignal.removeEventListener('abort', stop);
            try {
                const finalSearch =
                    activity?.status === 'searching'
                        ? {
                              ...activity,
                              status:
                                  status === 'stopped'
                                      ? ('stopped' as const)
                                      : ('failed' as const),
                          }
                        : activity;
                await onSettled?.({
                    content,
                    status,
                    ...(finalSearch && { search: finalSearch }),
                });
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

        const trackedStream = (context: ModelMessage[]) => {
            const { answer, errorText } = startModel(context);
            return answer.toUIMessageStream({ errorText }).pipeThrough(
                new TransformStream<UIMessageChunk, UIMessageChunk>({
                    async transform(part, controller) {
                        if (
                            thinking === false &&
                            part.type === 'reasoning-delta'
                        ) {
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
        };
        const stream = search
            ? createUIMessageStream({
                  execute: async ({ writer }) => {
                      if (clientSignal.aborted) return;
                      writer.write({
                          type: 'data-chat-search',
                          id: search.id,
                          data: search,
                      });
                      try {
                          const result = await this.searchOnce(
                              search.query,
                              clientSignal,
                          );
                          clientSignal.throwIfAborted();
                          activity = {
                              ...search,
                              ...result,
                              status: result.error ? 'failed' : 'complete',
                          };
                          await onSearch?.(activity);
                          clientSignal.throwIfAborted();
                          writer.write({
                              type: 'data-chat-search',
                              id: activity.id,
                              data: activity,
                          });
                          writer.merge(
                              trackedStream(
                                  addSearchContext(messages, activity),
                              ),
                          );
                      } catch {
                          if (clientSignal.aborted) {
                              await settle('stopped');
                              return;
                          }
                          const saved = await settle('failed');
                          writer.write({
                              type: 'error',
                              errorText: saved
                                  ? 'The model is unavailable or the response failed.'
                                  : 'The reply could not be saved.',
                          });
                      }
                  },
              })
            : trackedStream(messages);
        return createUIMessageStreamResponse({ stream, keepAliveMs: 15_000 });
    }

    private searchAvailable() {
        return Boolean(this.config.get<string>('DEEPSEEK_SEARCH_API_KEY'));
    }

    private async searchOnce(
        query: string,
        signal: AbortSignal,
    ): Promise<SearchResult> {
        try {
            return await this.webSearch.search(query, signal);
        } catch {
            signal.throwIfAborted();
            return { sources: [], error: 'Web search failed.' };
        }
    }
}
