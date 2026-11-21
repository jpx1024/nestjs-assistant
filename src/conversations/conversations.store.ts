import { randomUUID } from 'node:crypto';
import {
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import type { ModelMessage } from 'ai';
import type { EntityManager } from 'typeorm';
import type { ReplyOutcome } from '../chat/chat.service.js';
import { SqliteDatabase } from '../database/sqlite.database.js';
import {
    ConversationEntity,
    MessageEntity,
    type Workspace,
} from './conversation.entity.js';

const untitled = '新对话';

export type ReplyRequest = { content: string; thinking?: boolean };

function summary({ id, title, createdAt, updatedAt }: ConversationEntity) {
    return { id, title, createdAt, updatedAt };
}

export class ConversationDatabase {
    constructor(
        protected readonly database: SqliteDatabase,
        protected readonly workspace: Workspace,
    ) {}

    list(query: string) {
        return this.database.run(async (manager) => {
            const conversations = manager
                .getRepository(ConversationEntity)
                .createQueryBuilder('conversation');
            const matches = conversations
                .subQuery()
                .select('1')
                .from(MessageEntity, 'message')
                .where('message.conversationId = conversation.id')
                .andWhere('instr(lower(message.content), lower(:query)) > 0');
            const rows = await conversations
                .where('conversation.workspace = :workspace', {
                    workspace: this.workspace,
                })
                .andWhere(
                    `(instr(lower(conversation.title), lower(:query)) > 0 OR EXISTS ${matches.getQuery()})`,
                    { query },
                )
                .orderBy('conversation.updatedAt', 'DESC')
                .addOrderBy('conversation.rowid', 'DESC')
                .getMany();
            return rows.map(summary);
        });
    }

    create() {
        return this.database.run(async (manager) => {
            const id = randomUUID();
            const now = new Date().toISOString();
            const conversation = {
                id,
                title: untitled,
                createdAt: now,
                updatedAt: now,
            };
            await manager.insert(ConversationEntity, {
                ...conversation,
                workspace: this.workspace,
            });
            return conversation;
        });
    }

    get(id: string) {
        return this.database.run((manager) =>
            this.readConversation(manager, id),
        );
    }

    protected async readConversation(manager: EntityManager, id: string) {
        const conversation = await this.find(manager, id);
        const messages = await this.messages(manager, id);
        return {
            ...summary(conversation),
            messages: messages.map(
                ({ id, role, content, status, thinking }) => ({
                    id,
                    role,
                    content,
                    status,
                    ...(thinking !== null ? { thinking: thinking === 1 } : {}),
                }),
            ),
        };
    }

    rename(id: string, title: string) {
        return this.database.run(async (manager) => {
            const result = await manager.update(
                ConversationEntity,
                this.scope(id),
                {
                    title,
                },
            );
            if (!result.affected) {
                throw new NotFoundException('Conversation not found.');
            }
            return summary(await this.find(manager, id));
        });
    }

    delete(id: string) {
        return this.database.transaction(async (manager) => {
            await this.find(manager, id);
            const last = await manager.findOne(MessageEntity, {
                where: { conversationId: id },
                order: { id: 'DESC' },
            });
            this.checkIdle(last);
            await manager.delete(ConversationEntity, this.scope(id));
        });
    }

    beginReply(id: string, message?: ReplyRequest) {
        return this.database.transaction((manager) =>
            this.prepareReply(manager, id, message),
        );
    }

    protected async prepareReply(
        manager: EntityManager,
        id: string,
        message?: ReplyRequest,
        responseFor?: ReadonlyMap<number, ModelMessage[]>,
    ) {
        const conversation = await this.find(manager, id);
        const messages = await this.messages(manager, id);
        const last = messages.at(-1);
        this.checkIdle(last);

        let replyId: number;
        if (message) {
            const { content, thinking } = message;
            await manager.insert(MessageEntity, {
                conversationId: id,
                role: 'user',
                content,
                status: 'complete',
                thinking: thinking === undefined ? null : thinking ? 1 : 0,
            });
            const reply = manager.create(MessageEntity, {
                conversationId: id,
                role: 'assistant',
                content: '',
                status: 'streaming',
                thinking: null,
            });
            await manager.insert(MessageEntity, reply);
            replyId = reply.id;
            if (!last && conversation.title === untitled) {
                const title = Array.from(content.replace(/\s+/g, ' '))
                    .slice(0, 32)
                    .join('');
                await manager.update(ConversationEntity, this.scope(id), {
                    title,
                });
            }
        } else {
            if (
                last?.role !== 'assistant' ||
                (last.status !== 'stopped' && last.status !== 'failed')
            ) {
                throw new ConflictException('No interrupted reply to retry.');
            }
            replyId = last.id;
            await manager.update(MessageEntity, replyId, {
                content: '',
                status: 'streaming',
            });
        }

        await this.touch(manager, id);
        const history = await this.messages(manager, id);
        const mode = history.at(-2)?.thinking;
        return {
            replyId,
            context: this.context(history, responseFor),
            thinking: mode == null ? undefined : mode === 1,
        };
    }

    finishReply(id: string, replyId: number, outcome: ReplyOutcome) {
        return this.database.transaction((manager) =>
            this.updateReply(manager, id, replyId, outcome),
        );
    }

    protected async updateReply(
        manager: EntityManager,
        id: string,
        replyId: number,
        outcome: ReplyOutcome,
    ) {
        if (!(await manager.existsBy(ConversationEntity, this.scope(id))))
            return;
        const result = await manager.update(
            MessageEntity,
            { id: replyId, conversationId: id, status: 'streaming' },
            outcome,
        );
        if (result.affected) {
            await this.touch(manager, id);
        }
    }

    private async find(manager: EntityManager, id: string) {
        const conversation = await manager.findOneBy(
            ConversationEntity,
            this.scope(id),
        );
        if (!conversation) {
            throw new NotFoundException('Conversation not found.');
        }
        return conversation;
    }

    private scope(id: string) {
        return { id, workspace: this.workspace };
    }

    private messages(manager: EntityManager, id: string) {
        return manager.find(MessageEntity, {
            where: { conversationId: id },
            order: { id: 'ASC' },
        });
    }

    private checkIdle(last: MessageEntity | null | undefined) {
        if (last?.status === 'streaming') {
            throw new ConflictException('A reply is already in progress.');
        }
    }

    private touch(manager: EntityManager, id: string) {
        return manager.update(ConversationEntity, this.scope(id), {
            updatedAt: new Date().toISOString(),
        });
    }

    private context(
        messages: MessageEntity[],
        responseFor?: ReadonlyMap<number, ModelMessage[]>,
    ): ModelMessage[] {
        const context: ModelMessage[] = [];
        for (const [index, message] of messages.entries()) {
            if (message.role !== 'user') {
                continue;
            }
            const reply = messages[index + 1];
            if (reply?.status === 'streaming') {
                context.push({ role: 'user', content: message.content });
            } else if (reply?.content) {
                context.push(
                    { role: 'user', content: message.content },
                    ...(responseFor?.get(reply.id) ?? [
                        { role: 'assistant', content: reply.content } as const,
                    ]),
                );
            }
        }
        return context;
    }
}

@Injectable()
export class ConversationsStore extends ConversationDatabase {
    constructor(database: SqliteDatabase) {
        super(database, 'chat');
    }
}
