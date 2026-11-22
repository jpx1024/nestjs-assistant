import type { AiUsage } from '@nestjs/ai';

export type ReplyUsage = AiUsage & { partial?: true };

export function reportedUsage(usage: AiUsage): ReplyUsage | undefined {
    // Nest normalizes unreported counters to zero.
    if (
        usage.totalTokens > 0 ||
        usage.inputTokens > 0 ||
        usage.outputTokens > 0
    ) {
        return usage;
    }
}

export function addPartialUsage(
    previous: ReplyUsage | undefined,
    usage: AiUsage,
): ReplyUsage | undefined {
    if (!reportedUsage(usage)) return previous;
    return {
        inputTokens: (previous?.inputTokens ?? 0) + usage.inputTokens,
        outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
        totalTokens: (previous?.totalTokens ?? 0) + usage.totalTokens,
        cachedInputTokens:
            (previous?.cachedInputTokens ?? 0) + usage.cachedInputTokens,
        reasoningTokens:
            (previous?.reasoningTokens ?? 0) + usage.reasoningTokens,
        partial: true,
    };
}
