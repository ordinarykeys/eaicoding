import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** SDK fetch transport. Real credentials stay native; SDK auth placeholders are discarded. */
export function providerFetch(
  profileId?: string,
  protocol?: string,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.signal.aborted)
      throw new DOMException("操作已取消", "AbortError");
    const requestId = crypto.randomUUID();
    const bodyText = await request.text();
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    const headers = Object.fromEntries(request.headers);
    for (const key of [
      "authorization",
      "x-api-key",
      "x-goog-api-key",
      "x-dsh-auth-token",
    ])
      delete headers[key];
    return new Promise<Response>((resolve, reject) => {
      const encoder = new TextEncoder();
      let sink!: ReadableStreamDefaultController<Uint8Array>;
      let started = false;
      let settled = false;
      let stopStart: (() => void) | undefined;
      let stopChunk: (() => void) | undefined;
      const cleanup = () => {
        stopStart?.();
        stopChunk?.();
        request.signal.removeEventListener("abort", abort);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        const failure =
          error instanceof Error ? error : new Error(String(error));
        if (started) sink.error(failure);
        else reject(failure);
      };
      const abort = () => {
        void invoke("cancel_agent_task", { requestId }).catch(() => {});
        fail(new DOMException("操作已取消", "AbortError"));
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          sink = controller;
        },
        cancel() {
          abort();
        },
      });
      request.signal.addEventListener("abort", abort, { once: true });
      void (async () => {
        stopStart = await listen<{
          requestId: string;
          status: number;
          statusText: string;
          headers: Record<string, string>;
        }>("llm-proxy-stream-start", ({ payload }) => {
          if (settled || started || payload.requestId !== requestId) return;
          started = true;
          resolve(
            new Response(stream, {
              status: payload.status,
              statusText: payload.statusText,
              headers: payload.headers,
            }),
          );
        });
        if (settled) {
          cleanup();
          return;
        }
        stopChunk = await listen<{ requestId: string; text: string }>(
          "llm-proxy-stream-chunk",
          ({ payload }) => {
            if (!settled && payload.requestId === requestId)
              sink.enqueue(encoder.encode(payload.text));
          },
        );
        if (settled || request.signal.aborted) {
          if (!settled) abort();
          cleanup();
          return;
        }
        const response = await invoke<{
          status: number;
          statusText: string;
          text: string;
        }>("llm_proxy_stream", {
          request: {
            profileId,
            protocol,
            requestId,
            url: request.url,
            method: request.method,
            headers,
            body,
            timeoutSecs: 120,
          },
          requestId,
        });
        if (settled) return;
        // Error bodies and non-stream responses arrive in the final reply.
        if (!started) {
          started = true;
          sink.enqueue(encoder.encode(response.text));
          resolve(
            new Response(stream, {
              status: response.status,
              statusText: response.statusText,
            }),
          );
        } else if (response.status >= 300)
          sink.enqueue(encoder.encode(response.text));
        settled = true;
        sink.close();
        cleanup();
      })().catch(fail);
    });
  };
}
