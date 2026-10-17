import {
  embedWithJingyiModel,
  type EmbeddingPipeline,
} from "@/services/agent/knowledge/jingyi-vector-search";
import type { StoredModuleIndex, UserModuleApi } from "@/services/knowledge/module-library";

// ---------------------------------------------------------------------------
// Per-module vector index — int8 quantised (scale=127) embeddings of public
// APIs, built once on upload and stored as base64 inside StoredModuleIndex.
//
// Reuses the same Xenova/bge-small-zh-v1.5 q8 extractor as 精易模块库 via the
// shared singleton in jingyi-vector-search.ts so we never load the ONNX model
// twice in one webview.
// ---------------------------------------------------------------------------

export type ModuleVectorIndex = NonNullable<StoredModuleIndex["vectorIndex"]>;

const MODEL_NAME = "Xenova/bge-small-zh-v1.5";
const VECTOR_SCALE = 127;
const BATCH_SIZE = 16;

// ---------------------------------------------------------------------------
// Vector text — what we actually embed for each API. Stays close to the
// jingyi-side `vectorText` signal (name + class + signature + description) so
// the embedding space is consistent with the built-in module's index.
// ---------------------------------------------------------------------------

function apiToVectorText(api: UserModuleApi): string {
  const parts = [
    api.name,
    api.className,
    api.returnType,
    api.signature,
    api.description,
    api.params
      .map((param) => `${param.name}${param.type ? ` ${param.type}` : ""}`)
      .join(" "),
  ];
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// int8 quantisation + base64 codec
// ---------------------------------------------------------------------------

function quantizeFloat32ToInt8(rows: Float32Array[], scale: number): Int8Array {
  if (rows.length === 0) return new Int8Array(0);
  const dimension = rows[0].length;
  const out = new Int8Array(rows.length * dimension);
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    const offset = r * dimension;
    for (let c = 0; c < dimension; c += 1) {
      const value = Math.round(row[c] * scale);
      out[offset + c] = value < -128 ? -128 : value > 127 ? 127 : value;
    }
  }
  return out;
}

function dequantizeRow(int8: Int8Array, dimension: number, rowIndex: number, scale: number): Float32Array {
  const start = rowIndex * dimension;
  const out = new Float32Array(dimension);
  for (let c = 0; c < dimension; c += 1) {
    out[c] = int8[start + c] / scale;
  }
  return out;
}

function encodeInt8ToBase64(bytes: Int8Array): string {
  // Re-interpret as Uint8Array (bit pattern is the same — int8 is just a signed view).
  const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < u8.length; i += chunkSize) {
    const chunk = u8.subarray(i, Math.min(u8.length, i + chunkSize));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function decodeBase64ToInt8(value: string): Int8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// ---------------------------------------------------------------------------
// Build — embed each API and pack into a single quantised buffer.
// ---------------------------------------------------------------------------

export async function buildModuleVectorIndex(
  apis: UserModuleApi[],
  onProgress?: (done: number, total: number) => void,
): Promise<ModuleVectorIndex | null> {
  if (apis.length === 0) return null;

  const total = apis.length;
  // Emit an initial 0/total tick so the UI flips to "indexing 0/N" before the
  // first batch (which may be slow if the wasm/model is still warming up).
  onProgress?.(0, total);

  const vectors: Float32Array[] = [];
  for (let start = 0; start < apis.length; start += BATCH_SIZE) {
    const batch = apis.slice(start, start + BATCH_SIZE);
    const embedded = await Promise.all(batch.map((api) => embedWithJingyiModel(apiToVectorText(api))));
    vectors.push(...embedded);
    onProgress?.(Math.min(total, vectors.length), total);
  }

  const dimension = vectors[0]?.length ?? 0;
  if (dimension === 0) return null;

  const quantised = quantizeFloat32ToInt8(vectors, VECTOR_SCALE);
  return {
    model: MODEL_NAME,
    dimension,
    encoding: "int8",
    scale: VECTOR_SCALE,
    data: encodeInt8ToBase64(quantised),
    apiOrder: apis.map((api) => api.id),
    builtAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Search — embed query, cosine sim against stored int8 vectors.
// Vectors are L2-normalised at build time (we use `normalize: true` in the
// extractor), so cosine similarity collapses to dot product.
// ---------------------------------------------------------------------------

export interface ModuleVectorHit {
  apiId: string;
  similarity: number;
}

export async function searchModuleVectorIndex(
  index: ModuleVectorIndex,
  queryEmbedding: Float32Array,
  limit: number,
): Promise<ModuleVectorHit[]> {
  if (!index.data || index.dimension <= 0 || index.apiOrder.length === 0) return [];
  if (queryEmbedding.length < index.dimension) return [];

  const int8 = decodeBase64ToInt8(index.data);
  const dim = index.dimension;
  const scale = index.scale || VECTOR_SCALE;
  const expectedRows = Math.floor(int8.length / dim);
  const rowCount = Math.min(index.apiOrder.length, expectedRows);

  const hits: ModuleVectorHit[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const vector = dequantizeRow(int8, dim, row, scale);
    let dot = 0;
    for (let c = 0; c < dim; c += 1) {
      dot += vector[c] * queryEmbedding[c];
    }
    hits.push({ apiId: index.apiOrder[row], similarity: dot });
  }

  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, Math.max(1, limit));
}

/** Lazy embed of the query string; consumers may reuse the result across modules. */
export async function embedQuery(query: string): Promise<Float32Array> {
  return embedWithJingyiModel(query);
}

/** Re-export the extractor type so callers don't depend on jingyi paths directly. */
export type { EmbeddingPipeline };
