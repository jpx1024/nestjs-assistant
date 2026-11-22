import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentRunEntity } from '../agent/agent-run.entity.js';
import {
    ConversationEntity,
    MessageEntity,
    ReplyAttemptEntity,
} from '../conversations/conversation.entity.js';
import { SqliteDatabase } from './sqlite.database.js';

@Module({
    imports: [
        TypeOrmModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => {
                const path = config.getOrThrow<string>('DB_PATH');
                const database = path === ':memory:' ? path : resolve(path);
                if (database !== ':memory:') {
                    mkdirSync(dirname(database), { recursive: true });
                }
                return {
                    type: 'better-sqlite3',
                    database,
                    timeout: 3000,
                    enableWAL: true,
                    synchronize:
                        config.get<boolean>('DB_SYNCHRONIZE') ??
                        config.get<string>('NODE_ENV') !== 'production',
                    retryAttempts: 1,
                    entities: [
                        ConversationEntity,
                        MessageEntity,
                        ReplyAttemptEntity,
                        AgentRunEntity,
                    ],
                };
            },
        }),
    ],
    providers: [SqliteDatabase],
    exports: [SqliteDatabase],
})
export class DatabaseModule {}
