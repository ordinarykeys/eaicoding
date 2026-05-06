import { createLLMProvider } from "@/services/llm";
import type { ChatMessage, LLMConfig } from "@/types/llm";

export interface ProviderRegressionCase {
  id: string;
  config: LLMConfig;
  prompt?: string;
}

export interface ProviderRegressionResult {
  id: string;
  protocol: string;
  model: string;
  ok: boolean;
  durationMs: number;
  tokenEvents: number;
  textLength: number;
  preview: string;
  error?: string;
}

export async function runProviderRegression(
  cases: ProviderRegressionCase[],
): Promise<ProviderRegressionResult[]> {
  installNodeTauriProxy();

  const results: ProviderRegressionResult[] = [];

  for (const item of cases) {
    const startedAt = Date.now();
    let text = "";
    let tokenEvents = 0;
    let error: string | undefined;

    const messages: ChatMessage[] = [
      {
        id: "system",
        role: "system",
        content: "你是 EAiCoding 的回归测试助手。请只用一句中文回答。",
        timestamp: startedAt,
      },
      {
        id: "user",
        role: "user",
        content: item.prompt ?? "请回复：EAiCoding provider 回归通过",
        timestamp: startedAt,
      },
    ];

    const provider = createLLMProvider({
      ...item.config,
      temperature: item.config.temperature ?? 0,
      maxTokens: item.config.maxTokens ?? 256,
    });

    await provider.stream(messages, {
      onToken(token) {
        tokenEvents += 1;
        text += token;
      },
      onComplete(fullText) {
        if (fullText && fullText.length >= text.length) {
          text = fullText;
        }
      },
      onError(err) {
        error = err.message;
      },
    }, {
      nativeTools: false,
    });

    const trimmed = text.trim();
    results.push({
      id: item.id,
      protocol: item.config.protocol,
      model: item.config.model,
      ok: Boolean(trimmed) && !error,
      durationMs: Date.now() - startedAt,
      tokenEvents,
      textLength: trimmed.length,
      preview: trimmed.slice(0, 160),
      error,
    });
  }

  return results;
}

function installNodeTauriProxy() {
  const globalObject = globalThis as typeof globalThis & {
    window?: typeof globalThis & {
      __TAURI_INTERNALS__?: {
        invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
        transformCallback: (callback?: unknown, once?: boolean) => number;
        unregisterCallback: (id: number) => void;
      };
    };
    __TAURI_EVENT_PLUGIN_INTERNALS__?: {
      unregisterListener: (event: string, eventId: number) => void;
    };
  };

  globalObject.window ??= globalObject;
  let callbackId = 1;
  let eventId = 1;
  const callbacks = new Map<number, (event: unknown) => void>();
  const eventListeners = new Map<number, { event: string; callbackId: number }>();

  const emit = (eventName: string, payload: unknown) => {
    for (const listener of eventListeners.values()) {
      if (listener.event !== eventName) continue;
      callbacks.get(listener.callbackId)?.({
        event: eventName,
        id: listener.callbackId,
        payload,
      });
    }
  };

  globalObject.window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(_event, listenerId) {
      eventListeners.delete(listenerId);
    },
  };

  globalObject.window.__TAURI_INTERNALS__ = {
    async invoke(cmd, args = {}) {
      if (cmd === "plugin:event|listen") {
        const listenerId = eventId++;
        const event = String(args.event ?? "");
        const handler = Number(args.handler);
        eventListeners.set(listenerId, { event, callbackId: handler });
        return listenerId;
      }

      if (cmd === "plugin:event|unlisten") {
        eventListeners.delete(Number(args.eventId));
        return null;
      }

      if (cmd !== "llm_proxy_stream" && cmd !== "llm_proxy_request") {
        throw new Error(`unsupported regression invoke command: ${cmd}`);
      }

      const request = args.request as {
        requestId?: string;
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: unknown;
        timeoutSecs?: number;
      };
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        Math.max(1, request.timeoutSecs ?? 120) * 1000,
      );

      try {
        const response = await fetch(request.url, {
          method: request.method ?? "POST",
          headers: request.headers ?? {},
          body: JSON.stringify(request.body ?? {}),
          signal: controller.signal,
        });
        let text = "";
        if (cmd === "llm_proxy_stream" && request.requestId && response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            text += chunk;
            emit("llm-proxy-stream-chunk", {
              requestId: request.requestId,
              text: chunk,
            });
          }
          text += decoder.decode();
        } else {
          text = await response.text();
        }
        return {
          status: response.status,
          statusText: response.statusText,
          text,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
    transformCallback: (callback) => {
      const id = callbackId++;
      if (typeof callback === "function") {
        callbacks.set(id, callback as (event: unknown) => void);
      }
      return id;
    },
    unregisterCallback: (id) => {
      callbacks.delete(id);
    },
  };
}
