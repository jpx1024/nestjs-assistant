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
    ContextWindowService,
    type ContextRequest,
    type ContextEstimate,
} from './context-window.js';
import {
    LmStudioThinkingService,
    lmStudioResponsesModel,
} from './lm-studio-thinking.service.js';
import { PromptService } from './prompt.service.js';
import {
    addPartialUsage,
    reportedUsage,
    type ReplyUsage,
} from './reply-usage.js';

export type ReplyOutcome = {
    content: string;
    status: 'complete' | 'stopped' | 'failed';
    search?: SearchActivity;
    usage?: ReplyUsage;
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
        private readonly contextWindow: ContextWindowService,
    ) {}

    async model() {
        return {
            provider: this.config.getOrThrow<string>('AI_PROVIDER'),
            model: this.config.getOrThrow<string>('AI_MODEL'),
            thinkingAvailable: await this.thinking.isAvailable(),
            searchAvailable: this.searchAvailable(),
        };
    }

    contextPreview(messages: ModelMessage[], request: ContextRequest) {
        const webSearch = request.webSearch === true && this.searchAvailable();
        return this.contextWindow.preview(
            'chat',
            this.prompts.renderSystemPrompt(undefined, webSearch),
            messages,
            { ...request, webSearch },
        );
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
        let usage: ReplyUsage | undefined;
        const contextUpdates: ContextEstimate[] = [];
        const startModel = (context: ModelMessage[]) => {
            const timeout = AbortSignal.timeout(
                this.config.getOrThrow<number>(
                    thinking ? 'AI_DEEP_TIMEOUT_MS' : 'AI_TIMEOUT_MS',
                ),
            );
            const answer = this.contextWindow.observe(
                'chat',
                thinking,
                (value) => contextUpdates.push(value),
                () =>
                    this.ai.streamText({
                        instructions: this.prompts.renderSystemPrompt(
                            undefined,
                            Boolean(search),
                        ),
                        messages: context,
                        abortSignal: AbortSignal.any([clientSignal, timeout]),
                        maxOutputTokens,
                        onUsage: (event) => {
                            usage = addPartialUsage(usage, event.usage);
                        },
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
                    }),
            );
            return {
                answer,
                errorText: () =>
                    timeout.aborted
                        ? 'The model took too long to respond.'
                        : 'The model is unavailable or the response failed.',
            };
        };
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
                    ...(usage && { usage }),
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
                        for (const data of contextUpdates.splice(0)) {
                            controller.enqueue({ type: 'data-context', data });
                        }
                        if (
                            thinking === false &&
                            part.type === 'reasoning-delta'
                        ) {
                            return;
                        }
                        if (part.type === 'text-delta') {
                            content += part.delta;
                        }
                        let failure: string | undefined;
                        if (part.type === 'finish') {
                            const counts = await answer.usage;
                            usage = reportedUsage(counts) ?? usage;
                            if (maxOutputTokens !== undefined) {
                                const empty = !content.trim();
                                // LM Studio can report completion with only reasoning and one token left.
                                const reachedLimit =
                                    part.finishReason === 'length' ||
                                    (empty &&
                                        counts.outputTokens >=
                                            Math.max(1, maxOutputTokens - 1));
                                if (reachedLimit || empty) {
                                    failure = reachedLimit
                                        ? 'The model reached the output token limit.'
                                        : 'The model ended without a text answer.';
                                }
                            }
                        }
                        if (part.type === 'finish' || part.type === 'error') {
                            const saved = await settle(
                                failure || part.type === 'error'
                                    ? 'failed'
                                    : 'complete',
                            );
                            if (saved && usage) {
                                controller.enqueue({
                                    type: 'data-usage',
                                    data: usage,
                                });
                            }
                            const terminalError = saved
                                ? failure
                                : 'The reply could not be saved.';
                            if (terminalError) {
                                controller.enqueue({
                                    type: 'error',
                                    errorText: terminalError,
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
