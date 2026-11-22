import { Module } from '@nestjs/common';
import { WebSearchModule } from '../search/web-search.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { ContextWindowModule } from './context-window.js';
import { LmStudioThinkingService } from './lm-studio-thinking.service.js';
import { PromptService } from './prompt.service.js';

@Module({
    imports: [WebSearchModule, ContextWindowModule],
    controllers: [ChatController],
    providers: [ChatService, PromptService, LmStudioThinkingService],
    exports: [ChatService],
})
export class ChatModule {}
