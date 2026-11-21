import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import {
    maxSearchQueryLength,
    type SearchActivity,
} from '../search/web-search.js';

export function createChatSearch(
    question: string,
    id: string = randomUUID(),
): SearchActivity {
    const query = Array.from(question.trim().replace(/\s+/gu, ' '))
        .slice(0, maxSearchQueryLength)
        .join('');
    return { id, query, status: 'searching', sources: [] };
}

export function addSearchContext(
    messages: ModelMessage[],
    { query, status, sources }: SearchActivity,
): ModelMessage[] {
    const question = messages.at(-1);
    if (question?.role !== 'user') return messages;
    const data =
        '本轮联网搜索资料（JSON）\n' +
        JSON.stringify({ query, status, sources });
    const content =
        typeof question.content === 'string'
            ? `${question.content}\n\n${data}`
            : [...question.content, { type: 'text' as const, text: data }];
    return [...messages.slice(0, -1), { ...question, content }];
}
