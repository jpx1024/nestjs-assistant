import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { LmStudioThinkingService } from './lm-studio-thinking.service.js';
import { PromptService } from './prompt.service.js';

@Module({
    controllers: [ChatController],
    providers: [ChatService, PromptService, LmStudioThinkingService],
    exports: [ChatService],
})
export class ChatModule {}
