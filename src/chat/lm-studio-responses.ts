import { parseJsonEventStream } from 'ai';
import { z } from 'zod';

const reasoningDelta = z.object({
    type: z.literal('response.reasoning_text.delta'),
    item_id: z.string(),
    output_index: z.number().optional(),
    delta: z.string(),
});

export async function fetchLmStudioResponses(
    ...args: Parameters<typeof fetch>
): Promise<Response> {
    const response = await fetch(...args);
    if (
        !response.ok ||
        !response.body ||
        !response.headers.get('Content-Type')?.includes('text/event-stream')
    ) {
        return response;
    }

    const body = parseJsonEventStream({
        stream: response.body,
        schema: z.unknown(),
    })
        .pipeThrough(
            new TransformStream({
                transform(result, controller) {
                    if (!result.success) {
                        throw result.error;
                    }
                    const reasoning = reasoningDelta.safeParse(result.value);
                    // The Responses SDK reads reasoning text from its summary delta event.
                    const event = reasoning.success
                        ? {
                              ...reasoning.data,
                              type: 'response.reasoning_summary_text.delta',
                              summary_index: 0,
                          }
                        : result.value;
                    controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
                },
            }),
        )
        .pipeThrough(new TextEncoderStream());

    const headers = new Headers(response.headers);
    headers.delete('Content-Length');
    headers.delete('Content-Encoding');
    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}
