import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "url";
import path from "path";

// process is provided by @types/node
const host = process.env.TAURI_DEV_HOST;

const rootDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Dev-only plugin: when transformers.js / onnxruntime-web does
 *   await import('/ort/ort-wasm-simd-threaded.asyncify.mjs')
 * vite refuses, because /public/ files cannot be imported as source modules
 * (only fetched). Re-resolve those imports to the matching files in
 * node_modules/onnxruntime-web/dist so dev works without a CDN round-trip.
 *
 * In prod (vite build) `public/ort/*` is copied as-is into `dist/ort/`, served
 * over plain HTTP — fetch + import work fine there, no plugin needed.
 */
const ortMjsDevRedirect = {
  name: "ort-mjs-dev-redirect",
  apply: "serve" as const,
  enforce: "pre" as const,
  resolveId(source: string) {
    if (typeof source !== "string") return null;
    if (!source.startsWith("/ort/")) return null;
    const filename = source.slice("/ort/".length).split("?")[0];
    if (!filename) return null;
    return path.join(rootDir, "node_modules/onnxruntime-web/dist", filename);
  },
};

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [ortMjsDevRedirect, react(), tailwindcss()],
  resolve: {
    alias: {
      "@": rootDir + "src",
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    fs: {
      // Allow vite to serve files from node_modules/onnxruntime-web/dist when
      // the dev redirect above resolves /ort/* to that path.
      allow: [rootDir],
    },
  },
}));
