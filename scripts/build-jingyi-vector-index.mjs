#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env, pipeline } from "@huggingface/transformers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const rawPath = path.join(projectRoot, "src", "services", "agent", "knowledge", "jingyi-raw.json");
const modelPath = path.join(projectRoot, "public", "models", "Xenova", "bge-small-zh-v1.5");
const outputPath = path.join(projectRoot, "public", "models", "jingyi-vector-index.json");
const vectorOutputPath = path.join(projectRoot, "public", "models", "jingyi-vector-index.i8");
const batchSize = Number(process.env.JINGYI_VECTOR_BATCH_SIZE ?? "32");
const vectorScale = 127;

env.allowLocalModels = true;
env.allowRemoteModels = false;

function publicParams(params) {
  if (!Array.isArray(params)) return [];
  const result = [];

  for (const param of params) {
    const name = typeof param.name === "string" ? param.name.trim() : "";
    const type = typeof param.type === "string" ? param.type.trim() : "";
    if (!name && !type) continue;

    if (
      name.startsWith("局_") ||
      name.startsWith("局") ||
      /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ||
      name === "i" ||
      name === "n" ||
      name === "len"
    ) {
      break;
    }

    result.push({ name, type });
  }

  return result;
}

function signature(item) {
  const name = item.name?.trim() || "未知命令";
  const returnType = item.returnType?.trim() || "无返回值";
  const params = publicParams(item.params)
    .map((param) => `${param.name}${param.type ? `: ${param.type}` : ""}`)
    .join("，");
  return `${returnType} ${name}（${params}）`;
}

function flatten(raw) {
  const items = [];
  for (const [category, categoryItems] of Object.entries(raw.categories ?? {})) {
    if (!Array.isArray(categoryItems)) continue;
    for (const item of categoryItems) {
      const name = item.name?.trim();
      if (!name) continue;
      const params = publicParams(item.params);
      items.push({
        name,
        category: item.category?.trim() || category,
        return_type: item.returnType?.trim() || "无返回值",
        signature: signature(item),
        description: item.description?.trim() || "",
        params,
      });
    }
  }
  return items;
}

function vectorText(item) {
  return [
    item.name,
    item.category,
    item.return_type,
    item.signature,
    item.description,
    item.params.map((param) => `${param.name}${param.type ? ` ${param.type}` : ""}`).join(" "),
  ]
    .filter(Boolean)
    .join(" ");
}

const raw = JSON.parse(await fs.readFile(rawPath, "utf8"));
const items = flatten(raw);
const extractor = await pipeline("feature-extraction", modelPath, { dtype: "q8" });
const vectors = [];

for (let start = 0; start < items.length; start += batchSize) {
  const batch = items.slice(start, start + batchSize);
  const batchVectors = await Promise.all(
    batch.map(async (item) => {
      const output = await extractor(vectorText(item), { pooling: "mean", normalize: true });
      return Array.from(output.data ?? []);
    }),
  );
  vectors.push(...batchVectors);
  process.stdout.write(`indexed ${vectors.length}/${items.length}\r`);
}

const index = {
  version: 1,
  model: "Xenova/bge-small-zh-v1.5",
  dimension: vectors[0]?.length ?? 0,
  vector_encoding: "int8_symmetric",
  vector_scale: vectorScale,
  vector_file: "jingyi-vector-index.i8",
  source: "jingyi-raw.json",
  item_count: items.length,
  built_at: new Date().toISOString(),
  items,
};

const quantized = new Int8Array(items.length * index.dimension);
for (let row = 0; row < vectors.length; row += 1) {
  const vector = vectors[row];
  for (let column = 0; column < index.dimension; column += 1) {
    quantized[row * index.dimension + column] = Math.max(
      -127,
      Math.min(127, Math.round((vector[column] ?? 0) * vectorScale)),
    );
  }
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(index)}\n`, "utf8");
await fs.writeFile(vectorOutputPath, Buffer.from(quantized.buffer));
process.stdout.write(`\nwritten ${outputPath}\n`);
process.stdout.write(`written ${vectorOutputPath}\n`);
