import { Module } from '@nestjs/common';
import { LmStudioThinkingService } from '../chat/lm-studio-thinking.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { AgentController } from './agent.controller.js';
import { AgentService } from './agent.service.js';
import { AgentStore } from './agent.store.js';

@Module({
    imports: [DatabaseModule],
    controllers: [AgentController],
    providers: [AgentService, AgentStore, LmStudioThinkingService],
})
export class AgentModule {}
