import {
    Check,
    Column,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryColumn,
    PrimaryGeneratedColumn,
    type Relation,
} from 'typeorm';
import type { ReplyOutcome } from '../chat/chat.service.js';
import type { ReplyUsage } from '../chat/reply-usage.js';
import type { SearchActivity } from '../search/web-search.js';

export type Workspace = 'chat' | 'agent';

@Entity('conversations')
@Index('conversations_by_workspace', ['workspace', 'updatedAt'])
@Check("workspace IN ('chat', 'agent')")
export class ConversationEntity {
    @PrimaryColumn('text')
    id: string;

    @Column('text')
    workspace: Workspace;

    @Column('text')
    title: string;

    @Column('text', { name: 'created_at' })
    createdAt: string;

    @Column('text', { name: 'updated_at' })
    updatedAt: string;
}

@Entity('messages')
@Index('messages_by_conversation', ['conversationId', 'id'])
@Check("role IN ('user', 'assistant')")
@Check("status IN ('complete', 'streaming', 'stopped', 'failed')")
@Check('thinking IN (0, 1)')
export class MessageEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column('text', { name: 'conversation_id' })
    conversationId: string;

    @ManyToOne(() => ConversationEntity, {
        nullable: false,
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'conversation_id' })
    conversation: Relation<ConversationEntity>;

    @Column('text')
    role: 'user' | 'assistant';

    @Column('text')
    content: string;

    @Column('text')
    status: ReplyOutcome['status'] | 'streaming';

    @Column('integer', { nullable: true })
    thinking: 0 | 1 | null;

    @Column('simple-json', { nullable: true })
    search: SearchActivity | null;

    @Column('simple-json', { nullable: true })
    usage: ReplyUsage | null;
}

@Entity('reply_attempts')
@Index('reply_attempts_by_message', ['replyId'])
export class ReplyAttemptEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column('integer', { name: 'reply_id' })
    replyId: number;

    @ManyToOne(() => MessageEntity, { nullable: false, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'reply_id' })
    reply: Relation<MessageEntity>;

    @Column({ type: 'boolean', default: false })
    finished: boolean;

    @Column({ type: 'boolean', default: false })
    legacy: boolean;

    @Column('simple-json', { nullable: true })
    usage: ReplyUsage | null;
}
