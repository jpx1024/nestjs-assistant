import { Injectable } from '@nestjs/common';
import type { ModelMessage } from 'ai';
import type { EntityManager } from 'typeorm';
import type { ReplyOutcome } from '../chat/chat.service.js';
import {
    ConversationDatabase,
    type ReplyRequest,
} from '../conversations/conversations.store.js';
import { SqliteDatabase } from '../database/sqlite.database.js';
import { AgentRunEntity } from './agent-run.entity.js';
import type { SearchActivity } from '../search/web-search.js';

type Run = { runId: number; replyId: number; conversationId: string };

@Injectable()
export class AgentStore extends ConversationDatabase {
    constructor(database: SqliteDatabase) {
        super(database, 'agent');
    }

    override get(id: string) {
        return this.database.run(async (manager) => {
            const data = await this.readConversation(manager, id);
            const runs = await this.latestRuns(manager, id);
            const searchesByReply = new Map(
                runs.map((run) => [run.replyId, run.searches]),
            );
            return {
                ...data,
                messages: data.messages.map((message) => {
                    const searches = searchesByReply.get(message.id);
                    if (message.role !== 'assistant' || !searches)
                        return message;
                    return {
                        ...message,
                        searches: searches.map((search) =>
                            search.status === 'searching' &&
                            message.status !== 'streaming'
                                ? { ...search, status: 'stopped' as const }
                                : search,
                        ),
                    };
                }),
            };
        });
    }

    beginRun(conversationId: string, message?: ReplyRequest) {
        return this.database.transaction(async (manager) => {
            const history = new Map<number, ModelMessage[]>();
            for (const run of await this.latestRuns(
                manager,
                conversationId,
                true,
            )) {
                if (run.modelMessages) {
                    history.set(
                        run.replyId,
                        JSON.parse(run.modelMessages) as ModelMessage[],
                    );
                }
            }
            const reply = await this.prepareReply(
                manager,
                conversationId,
                message,
                history,
            );
            const run = manager.create(AgentRunEntity, {
                replyId: reply.replyId,
                startedAt: new Date().toISOString(),
                status: 'running',
            });
            await manager.insert(AgentRunEntity, run);
            return {
                ...reply,
                run: { runId: run.id, replyId: reply.replyId, conversationId },
            };
        });
    }

    recordSearches({ runId, replyId }: Run, searches: SearchActivity[]) {
        return this.database.run((manager) =>
            manager.update(
                AgentRunEntity,
                { id: runId, replyId, status: 'running' },
                { searches },
            ),
        );
    }

    finishRun(
        run: Run,
        outcome: ReplyOutcome,
        searches: SearchActivity[],
        messages?: ModelMessage[],
    ) {
        return this.database.transaction(async (manager) => {
            const result = await manager.update(
                AgentRunEntity,
                { id: run.runId, replyId: run.replyId, status: 'running' },
                {
                    status: outcome.status,
                    finishedAt: new Date().toISOString(),
                    searches,
                    modelMessages: messages?.length
                        ? JSON.stringify(messages)
                        : null,
                },
            );
            if (result.affected) {
                await this.updateReply(
                    manager,
                    run.conversationId,
                    run.replyId,
                    outcome,
                );
            }
        });
    }

    private latestRuns(
        manager: EntityManager,
        conversationId: string,
        completedOnly = false,
    ) {
        const runs = manager
            .getRepository(AgentRunEntity)
            .createQueryBuilder('run');
        const latest = runs
            .subQuery()
            .select('MAX(attempt.id)')
            .from(AgentRunEntity, 'attempt')
            .where('attempt.replyId = run.replyId');
        if (completedOnly) {
            latest.andWhere('attempt.status = :status', { status: 'complete' });
        }
        return runs
            .innerJoin('run.reply', 'reply')
            .innerJoin('reply.conversation', 'conversation')
            .where(
                'conversation.id = :conversationId AND conversation.workspace = :workspace',
                {
                    conversationId,
                    workspace: this.workspace,
                },
            )
            .andWhere(`run.id = ${latest.getQuery()}`)
            .getMany();
    }
}
