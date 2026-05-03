import {
  JINGYI_ITEMS,
  type JingyiSearchItem,
} from "@/services/agent/knowledge/jingyi-data";

type FeatureExtractionPipeline = (
  input: string,
  options?: { pooling?: "mean"; normalize?: boolean },
) => Promise<{ data?: Float32Array | number[]; dims?: number[] }>;

interface VectorSearchHit {
  item: JingyiSearchItem;
  similarity: number;
}

interface PrebuiltVectorIndex {
  model: string;
  dimension: number;
  vector_file?: string;
  vector_encoding?: string;
  vector_scale?: number;
  items: JingyiSearchItem[];
  vectors?: number[][];
}

const PUBLIC_MODEL_PATH = "/models/Xenova/bge-small-zh-v1.5";
const PREBUILT_INDEX_PATH = "/models/jingyi-vector-index.json";
const BATCH_SIZE = 32;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
let indexPromise: Promise<Array<{ item: JingyiSearchItem; vector: Float32Array }>> | null = null;

function getModelPath(): string {
  const runtime = globalThis as typeof globalThis & {
    __EAICODING_LOCAL_EMBEDDING_MODEL_PATH__?: string;
  };
  return runtime.__EAICODING_LOCAL_EMBEDDING_MODEL_PATH__ || PUBLIC_MODEL_PATH;
}

function vectorText(item: JingyiSearchItem): string {
  return [
    item.name,
    item.category,
    item.class_name,
    item.return_type,
    item.signature,
    item.description,
    item.params.map((param) => `${param.name}${param.type ? ` ${param.type}` : ""}`).join(" "),
  ]
    .filter(Boolean)
    .join(" ");
}

function indexableItems(): JingyiSearchItem[] {
  return JINGYI_ITEMS;
}

function currentItemKey(item: JingyiSearchItem): string {
  return `${item.category}:${item.name}:${item.return_type}:${item.signature}`;
}

function hydratePrebuiltItem(item: JingyiSearchItem): JingyiSearchItem {
  const current = JINGYI_ITEMS.find((entry) => currentItemKey(entry) === currentItemKey(item));
  return current ? { ...item, ...current } : { ...item, class_name: item.class_name ?? "" };
}

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      return pipeline("feature-extraction", getModelPath(), { dtype: "q8" }) as Promise<FeatureExtractionPipeline>;
    })();
  }
  return extractorPromise;
}

async function embed(text: string): Promise<Float32Array> {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  const data = output.data ?? [];
  return data instanceof Float32Array ? data : new Float32Array(data);
}

function cosineNormalized(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    sum += left[i] * right[i];
  }
  return sum;
}

async function buildIndex(): Promise<Array<{ item: JingyiSearchItem; vector: Float32Array }>> {
  const prebuilt = await loadPrebuiltIndex();
  if (prebuilt) return prebuilt;

  const items = indexableItems();
  const entries: Array<{ item: JingyiSearchItem; vector: Float32Array }> = [];

  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    const batch = items.slice(start, start + BATCH_SIZE);
    const vectors = await Promise.all(batch.map((item) => embed(vectorText(item))));
    for (let index = 0; index < batch.length; index += 1) {
      entries.push({ item: batch[index], vector: vectors[index] });
    }
  }

  return entries;
}

async function loadPrebuiltIndex(): Promise<Array<{ item: JingyiSearchItem; vector: Float32Array }> | null> {
  try {
    const response = await fetch(PREBUILT_INDEX_PATH, { cache: "force-cache" });
    if (!response.ok) return null;
    const index = (await response.json()) as PrebuiltVectorIndex;
    if (!Array.isArray(index.items)) return null;

    if (index.vector_file && index.vector_encoding === "int8_symmetric") {
      const vectorResponse = await fetch(`/models/${index.vector_file}`, { cache: "force-cache" });
      if (!vectorResponse.ok) return null;
      const bytes = new Int8Array(await vectorResponse.arrayBuffer());
      const dimension = index.dimension;
      const scale = index.vector_scale || 127;
      if (dimension <= 0 || bytes.length < index.items.length * dimension) return null;

      return index.items.map((item, offset) => {
        const vector = new Float32Array(dimension);
        const vectorOffset = offset * dimension;
        for (let column = 0; column < dimension; column += 1) {
          vector[column] = bytes[vectorOffset + column] / scale;
        }
        return { item: hydratePrebuiltItem(item), vector };
      });
    }

    if (!Array.isArray(index.vectors)) return null;
    if (index.items.length !== index.vectors.length) return null;
    return index.items.map((item, offset) => ({
      item: hydratePrebuiltItem(item),
      vector: new Float32Array(index.vectors?.[offset] ?? []),
    }));
  } catch {
    return null;
  }
}

async function getIndex(): Promise<Array<{ item: JingyiSearchItem; vector: Float32Array }>> {
  if (!indexPromise) {
    indexPromise = buildIndex();
  }
  return indexPromise;
}

export async function semanticSearchJingyiModule(
  query: string,
  limit: number,
): Promise<{
  enabled: boolean;
  model: string;
  indexed_count: number;
  matches: VectorSearchHit[];
  error?: string;
}> {
  try {
    const [queryVector, index] = await Promise.all([embed(query), getIndex()]);
    const matches = index
      .map((entry) => ({
        item: entry.item,
        similarity: cosineNormalized(queryVector, entry.vector),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    return {
      enabled: true,
      model: getModelPath(),
      indexed_count: index.length,
      matches,
    };
  } catch (error) {
    return {
      enabled: false,
      model: getModelPath(),
      indexed_count: 0,
      matches: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
