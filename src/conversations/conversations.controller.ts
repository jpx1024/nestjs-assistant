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
import { ChatService } from '../chat/chat.service.js';
import { clientSignal } from '../chat/client-signal.js';
import { ConversationsStore } from './conversations.store.js';

const renameSchema = z.object({ title: z.string().trim().min(1).max(100) });
const messageSchema = z.object({
    content: z.string().trim().min(1).max(20_000),
    thinking: z.boolean().optional(),
});
const searchSchema = z.object({ q: z.string().trim().max(120).optional() });

@Controller('api/conversations')
@UsePipes(StandardSchemaValidationPipe)
export class ConversationsController {
    constructor(
        private readonly conversations: ConversationsStore,
        private readonly chat: ChatService,
    ) {}

    @Get()
    list(@Query({ schema: searchSchema }) { q }: z.infer<typeof searchSchema>) {
        return this.conversations.list(q ?? '');
    }

    @Post()
    create() {
        return this.conversations.create();
    }

    @Get(':id')
    get(@Param('id') id: string) {
        return this.conversations.get(id);
    }

    @Patch(':id')
    rename(
        @Param('id') id: string,
        @Body({ schema: renameSchema }) { title }: z.infer<typeof renameSchema>,
    ) {
        return this.conversations.rename(id, title);
    }

    @Delete(':id')
    @HttpCode(204)
    delete(@Param('id') id: string) {
        this.conversations.delete(id);
    }

    @Post(':id/messages')
    send(
        @Param('id') id: string,
        @Body({ schema: messageSchema })
        message: z.infer<typeof messageSchema>,
        @Res({ passthrough: true }) response: ExpressResponse,
    ) {
        return this.reply(id, response, message);
    }

    @Post(':id/messages/retry')
    retry(
        @Param('id') id: string,
        @Res({ passthrough: true }) response: ExpressResponse,
    ) {
        return this.reply(id, response);
    }

    private async reply(
        id: string,
        response: ExpressResponse,
        message?: z.infer<typeof messageSchema>,
    ) {
        const signal = clientSignal(response);
        const { replyId, context, thinking } = this.conversations.beginReply(
            id,
            message,
        );
        try {
            return await this.chat.stream(context, signal, {
                thinking,
                onSettled: (outcome) =>
                    this.conversations.finishReply(id, replyId, outcome),
            });
        } catch (error) {
            this.conversations.finishReply(id, replyId, {
                content: '',
                status: signal.aborted ? 'stopped' : 'failed',
            });
            throw error;
        }
    }
}
