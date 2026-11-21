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

export class SystemPromptTemplate {
    private readonly render: (context: PromptContext) => string;
    private readonly environment: Omit<PromptContext, 'currentDate'>;
    private readonly dateFormatter: Intl.DateTimeFormat;

    constructor(config: ConfigService, template: URL) {
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

        const source = readFileSync(template, 'utf8');
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

@Injectable()
export class PromptService extends SystemPromptTemplate {
    constructor(config: ConfigService) {
        super(
            config,
            new URL('../../prompts/assistant.system.md', import.meta.url),
        );
    }
}
