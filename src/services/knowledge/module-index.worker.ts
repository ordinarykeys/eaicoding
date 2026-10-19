import { parseRawModuleApis } from "./module-parser";
import { buildModuleVectorIndex } from "./module-vector-index";
import type { UserModuleApi } from "./module-library";
// Serialize model work so multiple imports share one extractor without competing
// inference calls. This worker never loads React or the settings store.
let queue = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<{ id: number; kind: "parse" | "vector"; input: string | UserModuleApi[] }>) => {
  if (data.kind === "parse") {
    try { self.postMessage({ id: data.id, result: parseRawModuleApis(data.input as string, (done, total) => self.postMessage({ id: data.id, done, total })) }); }
    catch (error) { self.postMessage({ id: data.id, error: String(error) }); }
    return;
  }
  queue = queue.catch(() => {}).then(async () => {
    const { id, kind, input } = data;
    const progress = (done: number, total: number) => self.postMessage({ id, done, total });
    try {
      const result = kind === "parse" ? parseRawModuleApis(input as string, progress) : await buildModuleVectorIndex(input as UserModuleApi[], progress);
      self.postMessage({ id, result });
    } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
  });
};
