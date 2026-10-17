import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Keep the JS loader and WASM from the same locked dependency version. These
// generated assets are served locally, never fetched from a CDN or committed.
const require = createRequire(import.meta.url);
const runtimeDir = dirname(require.resolve("onnxruntime-web"));
const targetDir = fileURLToPath(new URL("../public/ort/", import.meta.url));
const files = [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
];

await mkdir(targetDir, { recursive: true });
for (const filename of files) {
  await copyFile(join(runtimeDir, filename), join(targetDir, filename));
}
console.log(`Prepared ${files.length} local ONNX runtime assets in public/ort/`);
