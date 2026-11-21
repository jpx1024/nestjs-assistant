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
}
