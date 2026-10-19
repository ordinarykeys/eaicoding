import { copyFile, cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, "..");
const srcTauri = join(appRoot, "src-tauri");
const { version } = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("便携版需要 major.minor.patch 格式的版本号");
if (process.platform !== "win32") throw new Error("此脚本用于构建 Windows x64 便携版");
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--skip-build")) throw new Error("仅支持 --skip-build（复用同版本 Tauri 生产构建）");
const releaseRoot = join(appRoot, "release", `v${version}`);
const portableName = `EAiCoding_${version}_x64-portable`;
const portableRoot = join(releaseRoot, portableName);
const exePath = join(srcTauri, "target", "release", "tauri-app.exe");
const toolsPath = join(srcTauri, "resources", "eagent-tools");

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  const executable = process.platform === "win32" && command === "npm" ? "cmd.exe" : command;
  const spawnArgs =
    process.platform === "win32" && command === "npm"
      ? ["/d", "/s", "/c", "npm", ...args]
      : args;

  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, spawnArgs, {
      cwd: options.cwd ?? appRoot,
      stdio: "inherit",
      ...options,
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolveRun();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });
}

async function zipPortable() {
  const archiver = require("archiver");
  const zipPath = join(releaseRoot, portableName + ".zip");
  await mkdir(releaseRoot, { recursive: true });

  return new Promise((resolveZip, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 6 } });

    output.on("close", () => resolveZip(zipPath));
    output.on("error", reject);
    archive.on("warning", (err) => {
      if (err.code === "ENOENT") {
        console.warn(err);
      } else {
        reject(err);
      }
    });
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(portableRoot, portableName);
    archive.finalize().catch(reject);
  });
}

if (!args.includes("--skip-build")) {
  // Use the same Tauri production build as the installer. A plain cargo build
  // can differ in production configuration and overwrite the verified binary.
  await run("npm", ["run", "tauri", "--", "build", "--no-bundle", "--ci"]);
}

if (!(await exists(exePath))) {
  throw new Error(`缺少桌面程序：${exePath}`);
}
if (!(await exists(toolsPath))) {
  throw new Error(`缺少内置工具目录：${toolsPath}`);
}
if (!(await exists(join(toolsPath, "eroot", "e.zip")))) throw new Error("完整版缺少易语言环境包 eroot/e.zip");

const productVersion = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Item -LiteralPath $env:EAICODING_PACKAGE_EXE).VersionInfo.ProductVersion"], {
  encoding: "utf8", env: { ...process.env, EAICODING_PACKAGE_EXE: exePath }, windowsHide: true,
}).trim();
if (productVersion.match(/^\d+\.\d+\.\d+/)?.[0] !== version) throw new Error(`主程序版本 ${productVersion} 与 ${version} 不一致，请先重新构建`);

// Verify the absolute deletion target is a child of this version's output dir.
const outputRelative = relative(resolve(releaseRoot), resolve(portableRoot));
if (!outputRelative || outputRelative.startsWith("..") || outputRelative.includes(":")) throw new Error("无效的便携版输出目录");
await rm(portableRoot, { recursive: true, force: true });
await mkdir(portableRoot, { recursive: true });
await copyFile(exePath, join(portableRoot, "EAiCoding.exe"));
await copyFile(join(appRoot, "THIRD_PARTY_NOTICES.md"), join(portableRoot, "THIRD_PARTY_NOTICES.md"));
await cp(join(appRoot, "third_party/7zip"), join(portableRoot, "licenses/7zip"), { recursive: true });
await cp(toolsPath, join(portableRoot, "eagent-tools"), { recursive: true });

const zipPath = await zipPortable();
console.log(`portable package: ${portableRoot}`);
console.log(`portable zip: ${zipPath}`);
