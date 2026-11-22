import { Module } from '@nestjs/common';
import { ContextWindowModule } from '../chat/context-window.js';
import { LmStudioThinkingService } from '../chat/lm-studio-thinking.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { AgentController } from './agent.controller.js';
import { AgentService } from './agent.service.js';
import { AgentStore } from './agent.store.js';

@Module({
    imports: [DatabaseModule, ContextWindowModule],
    controllers: [AgentController],
    providers: [AgentService, AgentStore, LmStudioThinkingService],
})
export class AgentModule {}
