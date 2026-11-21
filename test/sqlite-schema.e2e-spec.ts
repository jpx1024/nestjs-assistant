import { mkdtemp, readdir, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiModule } from '@nestjs/ai';
import { FakeModel } from '@nestjs/ai/testing';
import { ConflictException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AgentRunEntity } from '../src/agent/agent-run.entity.js';
import { AgentModule } from '../src/agent/agent.module.js';
import { AgentStore } from '../src/agent/agent.store.js';
import { ConversationsModule } from '../src/conversations/conversations.module.js';
import { ConversationsStore } from '../src/conversations/conversations.store.js';

it('creates a file from entities and recovers independent Chat and Agent streams on restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nestjs-assistant-schema-'));
    const path = join(directory, 'assistant.sqlite');

    async function boot(synchronize: boolean) {
        const module = await Test.createTestingModule({
            imports: [
                ConfigModule.forRoot({
                    isGlobal: true,
                    ignoreEnvFile: true,
                    load: [
                        () => ({
                            DB_PATH: path,
                            DB_SYNCHRONIZE: synchronize,
                            AI_PROJECT_NAME: 'SQLite Schema Test',
                            AI_TIME_ZONE: 'Asia/Shanghai',
                        }),
                    ],
                }),
                AiModule.forRoot({
                    isGlobal: true,
                    models: { default: new FakeModel([]) },
                }),
                ConversationsModule,
                AgentModule,
            ],
        }).compile();
        await module.init();
        return module;
    }

    try {
        const first = await boot(true);
        let chatId: string;
        let agentId: string;
        try {
            const chat = first.get(ConversationsStore);
            const agent = first.get(AgentStore);
            const [chatConversation, agentConversation] = await Promise.all([
                chat.create(),
                agent.create(),
            ]);
            chatId = chatConversation.id;
            agentId = agentConversation.id;
            const [, attempt] = await Promise.all([
                chat.beginReply(chatId, {
                    content: 'Chat question',
                    thinking: false,
                }),
                agent.beginRun(agentId, {
                    content: 'Agent question',
                    thinking: true,
                }),
            ]);
            await agent.recordSearches(attempt.run, [
                {
                    id: 'lookup',
                    query: 'Agent question',
                    status: 'searching',
                    sources: [],
                },
            ]);
            await expect(agent.beginRun(agentId)).rejects.toBeInstanceOf(
                ConflictException,
            );
        } finally {
            await first.close();
        }

        const second = await boot(false);
        try {
            const chat = second.get(ConversationsStore);
            const agent = second.get(AgentStore);
            expect(await chat.get(chatId)).toMatchObject({
                messages: [{ thinking: false }, { status: 'stopped' }],
            });
            expect(await agent.get(agentId)).toMatchObject({
                messages: [
                    { thinking: true },
                    {
                        status: 'stopped',
                        searches: [{ id: 'lookup', status: 'stopped' }],
                    },
                ],
            });
            const source = second.get(DataSource);
            expect(
                await source.manager.findOneBy(AgentRunEntity, {
                    status: 'stopped',
                }),
            ).toMatchObject({
                finishedAt: expect.any(String),
            });
            await agent.delete(agentId);
            expect(await source.manager.count(AgentRunEntity)).toBe(0);
        } finally {
            await second.close();
        }
    } finally {
        for (const name of await readdir(directory)) {
            await rm(join(directory, name));
        }
        await rmdir(directory);
    }
});
