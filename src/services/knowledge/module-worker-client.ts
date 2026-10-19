import type { parseRawModuleApis } from "./module-parser";
import type { ModuleVectorIndex } from "./module-vector-index";
import type { UserModuleApi } from "./module-library";
let worker: Worker | null = null;
let counter = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; progress?: (done: number, total: number) => void }>();
function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./module-index.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    if (typeof data.done === "number") { request.progress?.(data.done, data.total); return; }
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error)); else request.resolve(data.result);
  };
  worker.onerror = () => {
    for (const request of pending.values()) request.reject(new Error("模块索引工作线程异常，请重试"));
    pending.clear(); worker?.terminate(); worker = null;
  };
  return worker;
}
export function moduleWorkerRequest(kind: "parse", input: string, progress?: (done: number, total: number) => void): Promise<ReturnType<typeof parseRawModuleApis>>;
export function moduleWorkerRequest(kind: "vector", input: UserModuleApi[], progress?: (done: number, total: number) => void): Promise<ModuleVectorIndex | null>;
export function moduleWorkerRequest(kind: "parse" | "vector", input: string | UserModuleApi[], progress?: (done: number, total: number) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const instance = getWorker(), id = ++counter;
    pending.set(id, { resolve, reject, progress });
    instance.postMessage({ id, kind, input });
  });
}
