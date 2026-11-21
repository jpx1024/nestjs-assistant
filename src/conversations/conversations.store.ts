import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
    ConflictException,
    Injectable,
    NotFoundException,
    type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ModelMessage } from 'ai';
import type { ReplyOutcome } from '../chat/chat.service.js';

const untitled = '新对话';
const conversationColumns =
    'id, title, created_at AS createdAt, updated_at AS updatedAt';

type Conversation = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
};

type Message = {
    id: number;
    role: 'user' | 'assistant';
    content: string;
    status: ReplyOutcome['status'] | 'streaming';
    thinking: 0 | 1 | null;
};

@Injectable()
export class ConversationsStore implements OnApplicationShutdown {
    private readonly db: DatabaseSync;

    constructor(config: ConfigService) {
        const configuredPath = config.getOrThrow<string>('CHAT_DB_PATH');
        const path =
            configuredPath === ':memory:'
                ? configuredPath
                : resolve(configuredPath);
        if (path !== ':memory:') {
            mkdirSync(dirname(path), { recursive: true });
        }
        this.db = new DatabaseSync(path);
        this.db.exec(`
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 3000;
            PRAGMA journal_mode = WAL;

            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            ) STRICT;

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                content TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('complete', 'streaming', 'stopped', 'failed')),
                thinking INTEGER CHECK (thinking IN (0, 1))
            ) STRICT;

            CREATE INDEX IF NOT EXISTS messages_by_conversation
                ON messages(conversation_id, id);

            UPDATE messages SET status = 'stopped' WHERE status = 'streaming';
        `);
        this.transaction(() => {
            const columns = this.db
                .prepare('PRAGMA table_info(messages)')
                .all();
            if (!columns.some(({ name }) => name === 'thinking')) {
                this.db.exec(
                    'ALTER TABLE messages ADD COLUMN thinking INTEGER CHECK (thinking IN (0, 1))',
                );
            }
        });
    }

    onApplicationShutdown() {
        this.db.close();
    }

    list(query: string): Conversation[] {
        return this.db
            .prepare(
                `
                SELECT ${conversationColumns}
                FROM conversations AS c
                WHERE instr(lower(c.title), lower(?)) > 0
                   OR EXISTS (
                        SELECT 1 FROM messages AS m
                        WHERE m.conversation_id = c.id
                          AND instr(lower(m.content), lower(?)) > 0
                   )
                ORDER BY c.updated_at DESC, c.rowid DESC
            `,
            )
            .all(query, query) as Conversation[];
    }

    create() {
        const id = randomUUID();
        const now = new Date().toISOString();
        this.db
            .prepare('INSERT INTO conversations VALUES (?, ?, ?, ?)')
            .run(id, untitled, now, now);
        return { id, title: untitled, createdAt: now, updatedAt: now };
    }

    get(id: string) {
        return {
            ...this.find(id),
            messages: this.messages(id).map(({ thinking, ...message }) => ({
                ...message,
                ...(thinking !== null ? { thinking: thinking === 1 } : {}),
            })),
        };
    }

    rename(id: string, title: string) {
        const result = this.db
            .prepare('UPDATE conversations SET title = ? WHERE id = ?')
            .run(title, id);
        if (!result.changes) {
            throw new NotFoundException('Conversation not found.');
        }
        return this.find(id);
    }

    delete(id: string) {
        this.transaction(() => {
            this.find(id);
            this.checkIdle(this.messages(id).at(-1));
            this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
        });
    }

    beginReply(id: string, message?: { content: string; thinking?: boolean }) {
        return this.transaction(() => {
            const conversation = this.find(id);
            const messages = this.messages(id);
            const last = messages.at(-1);
            this.checkIdle(last);

            let replyId: number;
            if (message) {
                const { content, thinking } = message;
                const insert = this.db.prepare(`
                    INSERT INTO messages (conversation_id, role, content, status, thinking)
                    VALUES (?, ?, ?, ?, ?)
                `);
                insert.run(
                    id,
                    'user',
                    content,
                    'complete',
                    thinking === undefined ? null : Number(thinking),
                );
                replyId = Number(
                    insert.run(id, 'assistant', '', 'streaming', null)
                        .lastInsertRowid,
                );
                if (!last && conversation.title === untitled) {
                    const title = Array.from(content.replace(/\s+/g, ' '))
                        .slice(0, 32)
                        .join('');
                    this.db
                        .prepare(
                            'UPDATE conversations SET title = ? WHERE id = ?',
                        )
                        .run(title, id);
                }
            } else {
                if (
                    last?.role !== 'assistant' ||
                    (last.status !== 'stopped' && last.status !== 'failed')
                ) {
                    throw new ConflictException(
                        'No interrupted reply to retry.',
                    );
                }
                replyId = last.id;
                this.db
                    .prepare(
                        "UPDATE messages SET content = '', status = 'streaming' WHERE id = ?",
                    )
                    .run(replyId);
            }

            this.touch(id);
            const history = this.messages(id);
            const mode = history.at(-2)?.thinking;
            return {
                replyId,
                context: this.context(history),
                thinking: mode == null ? undefined : mode === 1,
            };
        });
    }

    finishReply(
        id: string,
        replyId: number,
        { content, status }: ReplyOutcome,
    ) {
        this.transaction(() => {
            const result = this.db
                .prepare(
                    `
                    UPDATE messages SET content = ?, status = ?
                    WHERE id = ? AND conversation_id = ? AND status = 'streaming'
                `,
                )
                .run(content, status, replyId, id);
            if (result.changes) {
                this.touch(id);
            }
        });
    }

    private find(id: string) {
        const row = this.db
            .prepare(
                `SELECT ${conversationColumns} FROM conversations WHERE id = ?`,
            )
            .get(id) as Conversation | undefined;
        if (!row) {
            throw new NotFoundException('Conversation not found.');
        }
        return row;
    }

    private messages(id: string): Message[] {
        return this.db
            .prepare(
                `
                SELECT id, role, content, status, thinking
                FROM messages WHERE conversation_id = ? ORDER BY id
            `,
            )
            .all(id) as Message[];
    }

    private checkIdle(last: Message | undefined) {
        if (last?.status === 'streaming') {
            throw new ConflictException('A reply is already in progress.');
        }
    }

    private touch(id: string) {
        this.db
            .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
            .run(new Date().toISOString(), id);
    }

    private context(messages: Message[]): ModelMessage[] {
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
                    { role: 'assistant', content: reply.content },
                );
            }
        }
        return context;
    }

    private transaction<T>(operation: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = operation();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
}
