import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const config = JSON.parse(await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const cargo = await readFile(join(root, "src-tauri", "Cargo.toml"), "utf8");
const args = process.argv.slice(2);
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("此脚本用于 Windows x64 发布打包");
if (args.some(arg => arg !== "--skip-build")) throw new Error("仅支持 --skip-build（复用已完成的同版本安装包构建）");
if (!/^\d+\.\d+\.\d+$/.test(version) || config.version !== version || cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1] !== version) {
  throw new Error("package.json、Tauri 配置与 Cargo 包版本必须一致");
}

function npmRun(script, ...scriptArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", "npm", "run", script, "--", ...scriptArgs], { cwd: root, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${script} 失败：${code}`)));
  });
}

if (!args.includes("--skip-build")) await npmRun("tauri", "build", "--bundles", "nsis", "--ci");
const installerName = `${config.productName}_${version}_x64-setup.exe`;
const installerPath = join(root, "src-tauri", "target", "release", "bundle", "nsis", installerName);
await stat(installerPath); // Fail before building an archive if the installer is absent.
await npmRun("package:portable", "--skip-build");

const output = join(root, "release", `v${version}`);
await mkdir(output, { recursive: true });
await copyFile(installerPath, join(output, installerName));
await copyFile(join(root, "src-tauri", "resources", "eagent-tools", "eroot", "e.zip"), join(output, "e.zip"));
await copyFile(join(root, "docs", "releases", `v${version}.md`), join(output, "RELEASE_NOTES.md"));

const files = [installerName, `EAiCoding_${version}_x64-portable.zip`, "e.zip", "RELEASE_NOTES.md"];
const checksums = [];
for (const name of files) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(join(output, name))) digest.update(chunk);
  checksums.push(`${digest.digest("hex")}  ${name}`);
}
await writeFile(join(output, "SHA256SUMS.txt"), checksums.join("\n") + "\n", "utf8");
console.log(`Release v${version} prepared: ${output}`);
console.log("GitHub Release publication is a separate action.");
