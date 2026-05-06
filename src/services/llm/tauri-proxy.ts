import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface LlmProxyResponse {
  status: number;
  statusText: string;
  text: string;
}

interface LlmProxyStreamChunk {
  requestId: string;
  text: string;
}

export async function postJsonViaTauri(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutSecs = 120,
): Promise<LlmProxyResponse> {
  return invoke<LlmProxyResponse>("llm_proxy_request", {
    request: {
      url,
      method: "POST",
      headers,
      body,
      timeoutSecs,
    },
  });
}

export async function streamJsonViaTauri(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  onChunk: (text: string) => void,
  timeoutSecs = 120,
): Promise<LlmProxyResponse> {
  const requestId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `llm_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const unlisten = await listen<LlmProxyStreamChunk>(
    "llm-proxy-stream-chunk",
    (event) => {
      if (event.payload.requestId === requestId) {
        onChunk(event.payload.text);
      }
    },
  );

  try {
    return await invoke<LlmProxyResponse>("llm_proxy_stream", {
      request: {
        requestId,
        url,
        method: "POST",
        headers,
        body,
        timeoutSecs,
      },
    });
  } finally {
    unlisten();
  }
}
