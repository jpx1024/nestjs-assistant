import type { Response } from 'express';

export function clientSignal(response: Response): AbortSignal {
    const client = new AbortController();
    response.once('close', () => {
        if (!response.writableFinished) {
            client.abort();
        }
    });
    return client.signal;
}
