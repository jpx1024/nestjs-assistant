import { ConfigService } from '@nestjs/config';
import { PromptService } from './prompt.service.js';

describe('PromptService', () => {
    it('renders plain Markdown and refreshes the date in the configured time zone', () => {
        const prompts = new PromptService(
            new ConfigService({
                AI_PROJECT_NAME: 'R&D',
                AI_TIME_ZONE: 'Asia/Shanghai',
            }),
        );

        const beforeMidnight = prompts.renderSystemPrompt(
            new Date('2026-11-21T15:59:00.000Z'),
        );
        const afterMidnight = prompts.renderSystemPrompt(
            new Date('2026-11-21T16:00:00.000Z'),
        );

        expect(beforeMidnight).toContain('## 运行环境');
        expect(beforeMidnight).toContain('项目名称：R&D');
        expect(beforeMidnight).toContain('当前日期：2026年11月21日');
        expect(afterMidnight).toContain('当前日期：2026年11月22日');
        expect(afterMidnight).toContain('时区：Asia/Shanghai');
        expect(afterMidnight).toContain(process.version);
    });
});
