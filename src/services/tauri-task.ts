import { invoke } from "@tauri-apps/api/core";

export function abortError(): Error {
  return new DOMException("操作已取消", "AbortError");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export async function abortable<T>(promise: Promise<T>, signal?: AbortSignal, onCancel?: () => void): Promise<T> {
  let cancel = () => {};
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      cancel = () => { onCancel?.(); reject(abortError()); };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    })]);
  } finally { signal?.removeEventListener("abort", cancel); }
}

/** Cancel the backend task as well as the caller's wait. Late replies are ignored. */
export async function invokeTask<T>(
  command: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return invoke<T>(command, args);
  const requestId = crypto.randomUUID();
  let onAbort: () => void = () => {};
  try {
    const request = invoke<T>(command, { ...args, requestId });
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => {
        void invoke("cancel_agent_task", { requestId }).catch(() => {});
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    return await Promise.race([request, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
