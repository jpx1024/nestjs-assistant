import {
    Check,
    Column,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    type Relation,
} from 'typeorm';
import type { ReplyOutcome } from '../chat/chat.service.js';
import { MessageEntity } from '../conversations/conversation.entity.js';
import type { SearchActivity } from './agent-search.js';

@Entity('agent_runs')
@Index('agent_runs_by_reply', ['replyId', 'id'])
@Check("status IN ('running', 'complete', 'stopped', 'failed')")
export class AgentRunEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column('integer', { name: 'reply_id' })
    replyId: number;

    @ManyToOne(() => MessageEntity, { nullable: false, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'reply_id' })
    reply: Relation<MessageEntity>;

    @Column('text', { name: 'started_at' })
    startedAt: string;

    @Column('text', { name: 'finished_at', nullable: true })
    finishedAt: string | null;

    @Column('text')
    status: ReplyOutcome['status'] | 'running';

    @Column('simple-json', { default: '[]' })
    searches: SearchActivity[];

    @Column('text', { name: 'model_messages', nullable: true })
    modelMessages: string | null;
}
