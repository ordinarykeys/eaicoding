import { build } from "esbuild";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function env(name) {
  const value = process.env[name]?.trim();
  return value ? value : "";
}

function parseProviderCases() {
  if (env("PROVIDER_REGRESSION_CASES")) {
    return JSON.parse(env("PROVIDER_REGRESSION_CASES"));
  }

  const protocol = env("PROVIDER_PROTOCOL") || "openai-chat-completions";
  const provider = env("PROVIDER_NAME") || "openai";
  const baseUrl = env("PROVIDER_BASE_URL");
  const apiKey = env("PROVIDER_API_KEY");
  const model = env("PROVIDER_MODEL");

  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      [
        "缺少真实 provider 回归配置。",
        "最小配置：PROVIDER_BASE_URL、PROVIDER_API_KEY、PROVIDER_MODEL。",
        "可选：PROVIDER_PROTOCOL=openai-chat-completions|openai-responses|anthropic-messages|gemini-generate-content，PROVIDER_NAME=openai|anthropic|provider|gemini。",
        "多服务商可传 PROVIDER_REGRESSION_CASES JSON 数组。",
      ].join("\n"),
    );
  }

  return [
    {
      id: env("PROVIDER_CASE_ID") || `${provider}:${model}`,
      prompt: env("PROVIDER_PROMPT") || undefined,
      config: {
        provider,
        protocol,
        baseUrl,
        apiKey,
        model,
        temperature: Number(env("PROVIDER_TEMPERATURE") || "0"),
        maxTokens: Number(env("PROVIDER_MAX_TOKENS") || "256"),
      },
    },
  ];
}

const outDir = path.join(repoRoot, ".tmp", "provider-regression");
await mkdir(outDir, { recursive: true });
const outfile = path.join(outDir, "provider-regression.bundle.mjs");

const result = await build({
  entryPoints: [path.join(repoRoot, "scripts", "provider-regression-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
  outfile,
  plugins: [
    {
      name: "alias-at",
      setup(buildInstance) {
        buildInstance.onResolve({ filter: /^@\// }, (args) => {
          const basePath = path.join(repoRoot, "src", args.path.slice(2));
          const candidates = [
            `${basePath}.ts`,
            `${basePath}.tsx`,
            `${basePath}.js`,
            path.join(basePath, "index.ts"),
            path.join(basePath, "index.tsx"),
            path.join(basePath, "index.js"),
            basePath,
          ];
          return { path: candidates.find((candidate) => existsSync(candidate)) ?? basePath };
        });
      },
    },
  ],
});

await writeFile(outfile, result.outputFiles[0].text, "utf8");
const { runProviderRegression } = await import(pathToFileURL(outfile).href);
const cases = parseProviderCases();
const results = await runProviderRegression(cases);
const summary = {
  passed: results.filter((item) => item.ok).length,
  total: results.length,
  results,
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (summary.passed !== summary.total) process.exitCode = 1;
