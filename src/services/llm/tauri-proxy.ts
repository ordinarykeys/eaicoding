import { invoke } from "@tauri-apps/api/core";

export interface LlmProxyResponse {
  status: number;
  statusText: string;
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
