import { fetchLmStudioResponses } from './lm-studio-responses.js';

afterEach(() => vi.restoreAllMocks());

describe('LM Studio Responses stream', () => {
    it('translates reasoning fragments and preserves the answer events', async () => {
        const events = [
            {
                type: 'response.output_item.added',
                item: { id: 'r1', type: 'reasoning' },
            },
            {
                type: 'response.reasoning_text.delta',
                item_id: 'r1',
                output_index: 0,
                delta: '先计算\n',
            },
            { type: 'response.output_text.delta', delta: '最终答案' },
        ];
        const source = events
            .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
            .join('');
        const bytes = new TextEncoder().encode(source);
        const body = new ReadableStream({
            start(controller) {
                for (const byte of bytes)
                    controller.enqueue(Uint8Array.of(byte));
                controller.close();
            },
        });
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(body, {
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Content-Length': String(bytes.byteLength),
                },
            }),
        );

        const result = await fetchLmStudioResponses(
            'http://localhost/v1/responses',
        );
        const parsed = (await result.text())
            .trim()
            .split('\n\n')
            .map((event) => JSON.parse(event.slice(6)));
        expect(parsed).toEqual([
            events[0],
            {
                ...events[1],
                type: 'response.reasoning_summary_text.delta',
                summary_index: 0,
            },
            events[2],
        ]);
        expect(result.headers.has('Content-Length')).toBe(false);
    });
});
