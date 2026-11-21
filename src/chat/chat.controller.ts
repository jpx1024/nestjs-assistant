import {
    Body,
    Controller,
    Get,
    Post,
    Res,
    StandardSchemaValidationPipe,
    UsePipes,
} from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { z } from 'zod';
import { createChatSearch } from './chat-search.js';
import { ChatService } from './chat.service.js';
import { clientSignal } from './client-signal.js';

const chatSchema = z.object({
    thinking: z.boolean().optional(),
    webSearch: z.boolean().optional(),
    messages: z
        .array(
            z.object({
                role: z.enum(['user', 'assistant']),
                content: z.string().refine((text) => text.trim().length > 0, {
                    message: 'Message content must not be blank',
                }),
            }),
        )
        .min(1)
        .refine((messages) => messages.at(-1)?.role === 'user', {
            message: 'Last message must have the user role',
        }),
});

@Controller('api/chat')
export class ChatController {
    constructor(private readonly chat: ChatService) {}

    @Get('model')
    model() {
        return this.chat.model();
    }

    @Post('stream')
    @UsePipes(StandardSchemaValidationPipe)
    stream(
        @Body({ schema: chatSchema })
        { messages, thinking, webSearch }: z.infer<typeof chatSchema>,
        @Res({ passthrough: true }) response: ExpressResponse,
    ): Promise<Response> {
        return this.chat.stream(messages, clientSignal(response), {
            thinking,
            search: webSearch
                ? createChatSearch(messages.at(-1)!.content)
                : undefined,
        });
    }
}
