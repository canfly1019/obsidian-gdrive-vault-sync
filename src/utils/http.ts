import { requestUrl } from 'obsidian';

// Obsidian's native transport works on desktop and mobile without browser CORS.
export async function http(url: string, options: RequestInit = {}) {
    const result = await requestUrl({
        url,
        method: options.method ?? 'GET',
        headers: Object.fromEntries(new Headers(options.headers).entries()),
        body: options.body instanceof URLSearchParams ? options.body.toString() : options.body as string | ArrayBuffer | undefined,
        throw: false
    });
    return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        headers: new Headers(result.headers),
        json: () => Promise.resolve(JSON.parse(result.text) as unknown),
        text: () => Promise.resolve(result.text),
        arrayBuffer: () => Promise.resolve(result.arrayBuffer)
    };
}
