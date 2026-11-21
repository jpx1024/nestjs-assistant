import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module.js';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsStore } from './conversations.store.js';

@Module({
    imports: [ChatModule],
    controllers: [ConversationsController],
    providers: [ConversationsStore],
})
export class ConversationsModule {}
