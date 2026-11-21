import { readFileSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Handlebars from 'handlebars';

type PromptContext = {
    projectName: string;
    currentDate: string;
    timeZone: string;
    nodeVersion: string;
};

@Injectable()
export class PromptService {
    private readonly render: (context: PromptContext) => string;
    private readonly environment: Omit<PromptContext, 'currentDate'>;
    private readonly dateFormatter: Intl.DateTimeFormat;

    constructor(config: ConfigService) {
        const timeZone = config.getOrThrow<string>('AI_TIME_ZONE');
        this.environment = {
            projectName: config.getOrThrow<string>('AI_PROJECT_NAME'),
            timeZone,
            nodeVersion: process.version,
        };
        this.dateFormatter = new Intl.DateTimeFormat('zh-CN', {
            timeZone,
            dateStyle: 'long',
        });

        const source = readFileSync(
            new URL('../../prompts/assistant.system.md', import.meta.url),
            'utf8',
        );
        this.render = Handlebars.compile<PromptContext>(source, {
            strict: true,
            noEscape: true,
        });

        // Handlebars compiles on first render, so check the template at startup.
        this.renderSystemPrompt();
    }

    renderSystemPrompt(now = new Date()): string {
        return this.render({
            ...this.environment,
            currentDate: this.dateFormatter.format(now),
        }).trim();
    }
}
