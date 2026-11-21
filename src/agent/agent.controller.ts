import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
    Query,
    Res,
    StandardSchemaValidationPipe,
    UsePipes,
} from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { z } from 'zod';
import { clientSignal } from '../chat/client-signal.js';
import { AgentService } from './agent.service.js';
import { AgentStore } from './agent.store.js';

const renameSchema = z.object({ title: z.string().trim().min(1).max(100) });
const messageSchema = z.object({
    content: z.string().trim().min(1).max(20_000),
    thinking: z.boolean().optional(),
});
const searchSchema = z.object({ q: z.string().trim().max(120).optional() });

@Controller('api/agent')
@UsePipes(StandardSchemaValidationPipe)
export class AgentController {
    constructor(
        private readonly agent: AgentService,
        private readonly conversations: AgentStore,
    ) {}

    @Get('model')
    model() {
        return this.agent.model();
    }

    @Get('conversations')
    list(@Query({ schema: searchSchema }) { q }: z.infer<typeof searchSchema>) {
        return this.conversations.list(q ?? '');
    }

    @Post('conversations')
    create() {
        return this.conversations.create();
    }

    @Get('conversations/:id')
    get(@Param('id') id: string) {
        return this.conversations.get(id);
    }

    @Patch('conversations/:id')
    rename(
        @Param('id') id: string,
        @Body({ schema: renameSchema }) { title }: z.infer<typeof renameSchema>,
    ) {
        return this.conversations.rename(id, title);
    }

    @Delete('conversations/:id')
    @HttpCode(204)
    delete(@Param('id') id: string) {
        return this.conversations.delete(id);
    }

    @Post('conversations/:id/messages')
    send(
        @Param('id') id: string,
        @Body({ schema: messageSchema }) message: z.infer<typeof messageSchema>,
        @Res({ passthrough: true }) response: ExpressResponse,
    ) {
        return this.agent.reply(id, clientSignal(response), message);
    }

    @Post('conversations/:id/messages/retry')
    retry(
        @Param('id') id: string,
        @Res({ passthrough: true }) response: ExpressResponse,
    ) {
        return this.agent.reply(id, clientSignal(response));
    }
}
