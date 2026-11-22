import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { AiModule } from '@nestjs/ai';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { createObserveModule } from '@nestjs/observe';
import { AgentModule } from './agent/agent.module.js';
import { AgentToolsModule } from './agent/agent-search.js';
import { agentModelName } from './agent/agent.service.js';
import { ChatModule } from './chat/chat.module.js';
import { withContextReporting } from './chat/context-window.js';
import { fetchLmStudioResponses } from './chat/lm-studio-responses.js';
import { lmStudioResponsesModel } from './chat/lm-studio-thinking.service.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { validateEnv } from './env.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        AiModule.forRootAsync({
            isGlobal: true,
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => {
                const name = config.getOrThrow<string>('AI_PROVIDER');
                const baseURL = config.getOrThrow<string>('AI_BASE_URL');
                const apiKey = config.get<string>('AI_API_KEY');
                const modelId = config.getOrThrow<string>('AI_MODEL');
                const agentModel = config.get<string>('AGENT_MODEL');
                const agentIsLocal =
                    config.get<string>('AGENT_PROVIDER') === 'lm-studio';
                const agentKey = config.get<string>('AGENT_API_KEY');
                const provider = createOpenAICompatible({
                    name,
                    baseURL,
                    apiKey,
                    includeUsage: config.getOrThrow<boolean>(
                        'AI_INCLUDE_STREAM_USAGE',
                    ),
                });

                return {
                    include: [AgentToolsModule],
                    models: {
                        default: {
                            model: withContextReporting(provider(modelId)),
                            temperature:
                                config.getOrThrow<number>('AI_TEMPERATURE'),
                        },
                        ...(name === 'lm-studio'
                            ? {
                                  [lmStudioResponsesModel]:
                                      withContextReporting(
                                          createOpenAI({
                                              baseURL,
                                              apiKey: apiKey ?? 'lm-studio',
                                              fetch: fetchLmStudioResponses,
                                          }).responses(modelId),
                                      ),
                              }
                            : {}),
                        ...(agentModel && (agentIsLocal || agentKey)
                            ? {
                                  [agentModelName]: withContextReporting(
                                      createOpenAI({
                                          baseURL:
                                              config.getOrThrow<string>(
                                                  'AGENT_BASE_URL',
                                              ),
                                          apiKey: agentKey ?? 'lm-studio',
                                          ...(agentIsLocal
                                              ? {
                                                    fetch: fetchLmStudioResponses,
                                                }
                                              : {}),
                                      }).responses(agentModel),
                                  ),
                              }
                            : {}),
                    },
                    defaults: {
                        maxOutputTokens: config.getOrThrow<number>(
                            'AI_MAX_OUTPUT_TOKENS',
                        ),
                        timeout: false,
                        retry: false,
                    },
                };
            },
        }),
        ChatModule,
        ConversationsModule,
        AgentToolsModule,
        AgentModule,
        // Distributed tracing, auto-correlated logs, request/job metrics, error
        // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com,
        // then run `npx @nestjs/observe link` to write your key pair into .env.
        ObserveModule.forRoot({
            appKey: process.env.OBSERVE_APP_KEY ?? 'YOUR_APP_KEY',
            appSecret: process.env.OBSERVE_APP_SECRET ?? 'YOUR_APP_SECRET',
            serviceId: 'nestjs-assistant',
        }),
    ],
})
export class AppModule {}
