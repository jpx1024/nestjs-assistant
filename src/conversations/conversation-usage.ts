import type { ReplyUsage } from '../chat/reply-usage.js';

export function summarizeConversationUsage(
    attempts: { usage: ReplyUsage | null; legacy: boolean }[],
) {
    const result = {
        attempts: attempts.length,
        partialAttempts: 0,
        unknownAttempts: 0,
        legacyAttempts: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
    };
    for (const { usage, legacy } of attempts) {
        if (legacy) result.legacyAttempts++;
        if (!usage) {
            result.unknownAttempts++;
            continue;
        }
        if (usage.partial) result.partialAttempts++;
        result.inputTokens += usage.inputTokens;
        result.outputTokens += usage.outputTokens;
        result.totalTokens += usage.totalTokens;
        result.cachedInputTokens += usage.cachedInputTokens;
        result.reasoningTokens += usage.reasoningTokens;
    }
    return result;
}
