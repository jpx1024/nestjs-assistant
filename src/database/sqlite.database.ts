import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { AgentRunEntity } from '../agent/agent-run.entity.js';
import {
    MessageEntity,
    ReplyAttemptEntity,
} from '../conversations/conversation.entity.js';

@Injectable()
export class SqliteDatabase implements OnModuleInit {
    private pending = Promise.resolve();

    constructor(private readonly source: DataSource) {}

    onModuleInit() {
        return this.transaction(async (manager) => {
            await manager.update(
                MessageEntity,
                { status: 'streaming' },
                { status: 'stopped' },
            );
            await manager.update(
                ReplyAttemptEntity,
                { finished: false },
                { finished: true },
            );
            await manager.update(
                AgentRunEntity,
                { status: 'running' },
                {
                    status: 'stopped',
                    finishedAt: new Date().toISOString(),
                },
            );
        });
    }

    run<T>(operation: (manager: EntityManager) => Promise<T>) {
        // Both stores use the same connection, so all queries wait for any active transaction.
        const result = this.pending.then(() => operation(this.source.manager));
        this.pending = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    transaction<T>(operation: (manager: EntityManager) => Promise<T>) {
        return this.run(async () => {
            const runner = this.source.createQueryRunner();
            try {
                // Reserve the write lock before checking the latest reply.
                await runner.query('BEGIN IMMEDIATE');
                try {
                    const result = await operation(runner.manager);
                    await runner.query('COMMIT');
                    return result;
                } catch (error) {
                    await runner.query('ROLLBACK');
                    throw error;
                }
            } finally {
                await runner.release();
            }
        });
    }
}
