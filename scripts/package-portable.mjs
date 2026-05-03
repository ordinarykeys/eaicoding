import { copyFile, cp, mkdir, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, "..");
const srcTauri = join(appRoot, "src-tauri");
const releaseRoot = join(appRoot, "release");
const portableRoot = join(releaseRoot, "易语言AI助手-portable");
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

async function findCargo() {
  if (process.env.CARGO && await exists(process.env.CARGO)) {
    return process.env.CARGO;
  }

  const cargoFromHome = process.env.USERPROFILE
    ? join(process.env.USERPROFILE, ".cargo", "bin", "cargo.exe")
    : "";
  if (cargoFromHome && await exists(cargoFromHome)) {
    return cargoFromHome;
  }

  return "cargo";
}

async function zipPortable() {
  const archiver = require("archiver");
  const zipPath = join(releaseRoot, "易语言AI助手-portable.zip");
  await mkdir(releaseRoot, { recursive: true });

  return new Promise((resolveZip, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 0 } });

    output.on("close", () => resolveZip(zipPath));
    archive.on("warning", (err) => {
      if (err.code === "ENOENT") {
        console.warn(err);
      } else {
        reject(err);
      }
    });
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(portableRoot, "易语言AI助手-portable");
    archive.finalize();
  });
}

await run("npm", ["run", "build"]);
await run(await findCargo(), ["build", "--release"], { cwd: srcTauri });

if (!(await exists(exePath))) {
  throw new Error(`缺少桌面程序：${exePath}`);
}
if (!(await exists(toolsPath))) {
  throw new Error(`缺少内置工具目录：${toolsPath}`);
}

await rm(portableRoot, { recursive: true, force: true });
await mkdir(portableRoot, { recursive: true });
await copyFile(exePath, join(portableRoot, "易语言AI助手.exe"));
await cp(toolsPath, join(portableRoot, "eagent-tools"), { recursive: true });

const zipPath = await zipPortable();
console.log(`portable package: ${portableRoot}`);
console.log(`portable zip: ${zipPath}`);
