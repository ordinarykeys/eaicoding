#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const inputPath = process.argv[2];
const outputPath = path.join(
  projectRoot,
  "src",
  "services",
  "agent",
  "knowledge",
  "jingyi-docs.json",
);

if (!inputPath) {
  console.error("Usage: node scripts/build-jingyi-docs.mjs <jingyi parse_output.txt>");
  process.exit(1);
}

function splitELine(text) {
  const parts = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') quoted = !quoted;
    if (char === "," && !quoted) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  parts.push(current.trim());
  return parts;
}

function clean(value) {
  return String(value ?? "")
    .replace(/^"|"$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isPublicParamName(name) {
  return (
    name &&
    !name.startsWith("局_") &&
    !name.startsWith("局") &&
    !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) &&
    name !== "i" &&
    name !== "n" &&
    name !== "len"
  );
}

function parseProcedureLine(line) {
  const body = line.replace(/^\.(子程序|DLL命令|全局变量)\s*/, "");
  const parts = splitELine(body);
  const name = clean(parts[0]);
  if (!name) return null;

  const category = line.startsWith(".DLL命令")
    ? "DLL命令"
    : line.startsWith(".全局变量")
      ? "全局变量"
      : "子程序";

  return {
    name,
    category,
    return_type: clean(parts[1]) || "无返回值",
    description: clean(parts.slice(3).join("，")),
    params: [],
  };
}

function parseParamLine(line) {
  const body = line.replace(/^\.(参数|局部变量)\s*/, "");
  const parts = splitELine(body);
  return {
    name: clean(parts[0]),
    type: clean(parts[1]),
    attributes: clean(parts[2]),
    description: clean(parts.slice(3).join("，")),
  };
}

const content = await fs.readFile(inputPath, "utf8");
const docsByName = {};
let current = null;

for (const rawLine of content.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line) continue;

  if (
    line.startsWith(".子程序 ") ||
    line.startsWith(".DLL命令 ") ||
    line.startsWith(".全局变量 ")
  ) {
    current = parseProcedureLine(line);
    if (current) {
      docsByName[current.name] ??= [];
      docsByName[current.name].push(current);
    }
    continue;
  }

  if (current && line.startsWith(".参数 ")) {
    const param = parseParamLine(line);
    if (isPublicParamName(param.name)) {
      current.params.push(param);
    }
  }
}

for (const docs of Object.values(docsByName)) {
  for (const doc of docs) {
    doc.params = doc.params.filter(
      (param) => param.name || param.type || param.description || param.attributes,
    );
  }
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(docsByName)}\n`, "utf8");
console.log(`written ${outputPath}`);
