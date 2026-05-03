import { build } from "esbuild";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const baseUrl = process.env.AGENT_BASE_URL;
const apiKey = process.env.AGENT_API_KEY;
const model = process.env.AGENT_MODEL ?? "mimo-v2.5-pro";
const userInput =
  process.env.AGENT_USER_INPUT ??
  [
    "用户上传了以下本地文件，请用工具读取后再分析（.e/.ec 用 parse_efile，文本文件用 read_file）：",
    "- D:\\pingfan\\Downloads\\eaicoding\\gju\\队长模块_谷歌web自动化测试框架6.2.ec",
    "- D:\\pingfan\\Downloads\\eaicoding\\gju\\精易模块[v11.1.0].ec",
    "- D:\\pingfan\\Downloads\\eaicoding\\gju\\蛇钞助手V1.0+开源版.e",
    "",
    "用户补充说明：",
    "1. 先解析主程序 .e，导出文本工程并读取关键源码文件。",
    "2. 基于读取到的源码做最小必要优化，保留原项目功能和窗口结构；应修改导出的 .e.txt 并重建原工程，不要改写成单文件模板。",
    "3. 必须生成新的 .e 文件并调用 compile_efile 编译验证。",
    "4. 如果编译失败，必须根据报错继续修改并重新生成再编译。",
  ].join("\n");

if (!baseUrl || !apiKey) {
  console.error("Missing AGENT_BASE_URL or AGENT_API_KEY");
  process.exitCode = 1;
} else {
  const outDir = path.join(repoRoot, ".tmp", "agent-flow-smoke");
  await mkdir(outDir, { recursive: true });
  const outfile = path.join(outDir, "agent-flow-smoke.bundle.mjs");

  const result = await build({
    entryPoints: [path.join(repoRoot, "scripts", "agent-flow-smoke-entry.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    write: false,
    outfile,
    external: ["@huggingface/transformers", "onnxruntime-node"],
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
            const resolved = candidates.find((candidate) => existsSync(candidate));
            return {
              path: resolved ?? basePath,
            };
          });
        },
      },
    ],
  });

  await writeFile(outfile, result.outputFiles[0].text, "utf8");
  const { runSmoke } = await import(pathToFileURL(outfile).href);
  const smokeResult = await runSmoke({
    repoRoot,
    baseUrl,
    apiKey,
    model,
    userInput,
    maxSteps: Number(process.env.AGENT_MAX_STEPS ?? "12"),
  });

  process.stdout.write(`${JSON.stringify(smokeResult, null, 2)}\n`);
}
