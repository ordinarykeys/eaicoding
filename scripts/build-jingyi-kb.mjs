#!/usr/bin/env node
/**
 * Transform jingyi-raw.json into a compact TypeScript knowledge file
 * for injection into the agent system prompt.
 *
 * Usage:  node scripts/build-jingyi-kb.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

const RAW_PATH = path.resolve(
  PROJECT_ROOT,
  "src",
  "services",
  "agent",
  "knowledge",
  "jingyi-raw.json",
);
const OUT_PATH = path.resolve(
  PROJECT_ROOT,
  "src",
  "services",
  "agent",
  "knowledge",
  "jingyi-module.ts",
);

if (!fs.existsSync(RAW_PATH)) {
  console.error(`Raw data not found: ${RAW_PATH}`);
  console.error("Run fetch-jingyi-kb.mjs first.");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(RAW_PATH, "utf-8"));
const categories = raw.categories;

// ---------------------------------------------------------------------------
// Organize subroutines by functional domain (based on name prefix)
// ---------------------------------------------------------------------------

const DOMAIN_PREFIXES = [
  ["网页_", "网络通信"],
  ["网络_", "网络通信"],
  ["FTP_", "网络通信"],
  ["HTTP_", "网络通信"],
  ["Cookies_", "网络通信"],
  ["Socket_", "网络通信"],
  ["TCP_", "网络通信"],
  ["UDP_", "网络通信"],
  ["邮件_", "网络通信"],
  ["编码_", "编码转换"],
  ["URL_", "编码转换"],
  ["BASE64", "编码转换"],
  ["bin2hex", "编码转换"],
  ["hex2bin", "编码转换"],
  ["Unicode_", "编码转换"],
  ["UTF", "编码转换"],
  ["AES_", "加密解密"],
  ["DES_", "加密解密"],
  ["MD5", "加密解密"],
  ["SHA", "加密解密"],
  ["RSA_", "加密解密"],
  ["CRC", "加密解密"],
  ["HMAC", "加密解密"],
  ["加密_", "加密解密"],
  ["解密_", "加密解密"],
  ["哈希_", "加密解密"],
  ["线程_", "多线程"],
  ["信号量_", "多线程"],
  ["临界区_", "多线程"],
  ["互斥_", "多线程"],
  ["事件_", "多线程"],
  ["原子_", "多线程"],
  ["文件_", "文件操作"],
  ["目录_", "文件操作"],
  ["磁盘_", "文件操作"],
  ["路径_", "文件操作"],
  ["rar_", "文件操作"],
  ["RAR_", "文件操作"],
  ["zip_", "文件操作"],
  ["ZIP_", "文件操作"],
  ["压缩_", "文件操作"],
  ["文本_", "文本处理"],
  ["字节集_", "文本处理"],
  ["正则_", "文本处理"],
  ["JSON_", "文本处理"],
  ["json_", "文本处理"],
  ["XML_", "文本处理"],
  ["INI_", "文本处理"],
  ["进程_", "进程管理"],
  ["服务_", "进程管理"],
  ["模块_", "进程管理"],
  ["窗口_", "窗口操作"],
  ["热键_", "窗口操作"],
  ["鼠标_", "窗口操作"],
  ["键盘_", "窗口操作"],
  ["托盘_", "窗口操作"],
  ["菜单_", "窗口操作"],
  ["图片_", "图像处理"],
  ["图标_", "图像处理"],
  ["GDI_", "图像处理"],
  ["位图_", "图像处理"],
  ["注册表_", "注册表"],
  ["系统_", "系统信息"],
  ["环境_", "系统信息"],
  ["硬件_", "系统信息"],
  ["CPU_", "系统信息"],
  ["内存_", "内存操作"],
  ["指针_", "内存操作"],
  ["取指针", "内存操作"],
  ["取变量", "内存操作"],
  ["时间_", "日期时间"],
  ["日期_", "日期时间"],
  ["剪辑板_", "剪贴板"],
  ["剪贴板_", "剪贴板"],
  ["数据库_", "数据库"],
  ["E数据库_", "数据库"],
  ["SQL_", "数据库"],
  ["外部编辑框_", "外部控件"],
  ["外部列表框_", "外部控件"],
  ["外部组合框_", "外部控件"],
  ["外部超级列表框_", "外部控件"],
  ["外部树型框_", "外部控件"],
  ["外部单选框_", "外部控件"],
  ["外部滚动条_", "外部控件"],
  ["超级列表框_", "外部控件"],
  ["列表框_", "外部控件"],
  ["COM_", "COM接口"],
  ["IP_", "网络工具"],
  ["SEH_", "异常处理"],
];

function classifySubroutine(name) {
  for (const [prefix, domain] of DOMAIN_PREFIXES) {
    if (name.startsWith(prefix)) return domain;
  }
  return "其他";
}

// ---------------------------------------------------------------------------
// Build signatures
// ---------------------------------------------------------------------------

function makeSignature(item) {
  // Only keep public parameters (exclude internal vars starting with 局_)
  const publicParams = (item.params || []).filter(
    (p) => !p.name.startsWith("局_") && !p.name.startsWith("变_"),
  );
  const params = publicParams.map((p) => `${p.name}: ${p.type || "?"}`).join(", ");
  const ret = item.returnType ? ` → ${item.returnType}` : "";
  return `${item.name}(${params})${ret}`;
}

function makeCompactSignature(item) {
  const publicParams = (item.params || []).filter(
    (p) => !p.name.startsWith("局_") && !p.name.startsWith("变_"),
  );
  if (publicParams.length === 0) {
    const ret = item.returnType ? ` → ${item.returnType}` : "";
    return `${item.name}()${ret}`;
  }
  const params = publicParams.map((p) => p.name).join(", ");
  const ret = item.returnType ? ` → ${item.returnType}` : "";
  return `${item.name}(${params})${ret}`;
}

function makeDataTypeDef(item) {
  const members = (item.members || item.params || [])
    .filter((m) => !m.name.startsWith("局_") && !m.name.startsWith("变_"))
    .map((m) => m.name)
    .join(", ");
  return members ? `${item.name} { ${members} }` : item.name;
}

// ---------------------------------------------------------------------------
// Process subroutines
// ---------------------------------------------------------------------------

const subs = categories["子程序"] || [];
const domainMap = new Map(); // domain → [signature, ...]

for (const item of subs) {
  if (item.fetchError) continue;
  const domain = classifySubroutine(item.name);
  if (!domainMap.has(domain)) domainMap.set(domain, []);
  domainMap.get(domain).push(makeCompactSignature(item));
}

// ---------------------------------------------------------------------------
// Process data types
// ---------------------------------------------------------------------------

const dataTypes = categories["数据类型"] || [];
const typeLines = [];
for (const item of dataTypes) {
  if (item.fetchError) continue;
  if ((item.members || item.params || []).length > 0) {
    typeLines.push(makeDataTypeDef(item));
  }
}

// ---------------------------------------------------------------------------
// Process classes
// ---------------------------------------------------------------------------

const classItems = categories["类"] || [];
// Group by className
const classMap = new Map();
for (const item of classItems) {
  const cls = item.className || item.name;
  if (!classMap.has(cls)) classMap.set(cls, []);
  if (item.params && item.params.length > 0) {
    classMap.get(cls).push(makeSignature(item));
  } else if (cls !== item.name) {
    classMap.get(cls).push(item.name + "()");
  }
}

// ---------------------------------------------------------------------------
// Assemble output — prioritize domains by relevance
// ---------------------------------------------------------------------------

const DOMAIN_ORDER = [
  "网络通信",
  "编码转换",
  "加密解密",
  "多线程",
  "文本处理",
  "文件操作",
  "进程管理",
  "窗口操作",
  "图像处理",
  "注册表",
  "系统信息",
  "内存操作",
  "日期时间",
  "剪贴板",
  "数据库",
  "外部控件",
  "COM接口",
  "网络工具",
  "异常处理",
  "其他",
];

const sections = [];
const summarySections = [];

// Subroutines by domain — name-only list for full reference
for (const domain of DOMAIN_ORDER) {
  if (domain === "其他") continue;
  const sigs = domainMap.get(domain);
  if (!sigs || sigs.length === 0) continue;
  const names = sigs.map((s) => s.replace(/\(.*$/, ""));
  sections.push(`## ${domain}\n${names.join(", ")}`);
  // Summary: just domain + count + top 5 examples
  const examples = names.slice(0, 5).join(", ");
  summarySections.push(`${domain}(${names.length}): ${examples}...`);
}

// Data types — skip for compact prompt
// Classes — compact: class name + method names
if (classMap.size > 0) {
  const classLines = [];
  for (const [cls, methods] of classMap) {
    const methodNames = methods.map((m) => m.replace(/\(.*$/, ""));
    if (methodNames.length === 0) {
      classLines.push(cls);
    } else {
      classLines.push(`${cls}: ${methodNames.join(", ")}`);
    }
  }
  sections.push(`## 类\n${classLines.join("\n")}`);
  summarySections.push(`类(${classMap.size}): ${[...classMap.keys()].slice(0, 5).join(", ")}...`);
}

const referenceText = sections.join("\n\n");
const summaryText = summarySections.join("\n");

// ---------------------------------------------------------------------------
// Write TypeScript file — two exports:
// 1. JINGYI_MODULE_SUMMARY — compact (~2KB) for always-on system prompt
// 2. JINGYI_MODULE_REFERENCE — full name list for optional deep injection
// ---------------------------------------------------------------------------

const tsContent = `// Auto-generated from 精易模块 API documentation.
// Source: ec.ijingyi.com — fetched ${raw.fetchDate || "unknown"}
// Do NOT edit manually — regenerate with: node scripts/build-jingyi-kb.mjs

/** Compact summary for the system prompt (~2KB). Lists each domain with
 *  function count and 5 example names. */
export const JINGYI_MODULE_SUMMARY = ${JSON.stringify(summaryText)};

/** Full function name list grouped by domain. Inject when user needs
 *  detailed API lookup. */
export const JINGYI_MODULE_REFERENCE = ${JSON.stringify(referenceText)};
`;

fs.writeFileSync(OUT_PATH, tsContent, "utf-8");

const sizeKB = (Buffer.byteLength(referenceText, "utf-8") / 1024).toFixed(1);
console.log(`Written to ${OUT_PATH}`);
console.log(`Reference text size: ${sizeKB} KB`);
console.log(
  `Domains: ${DOMAIN_ORDER.filter((d) => domainMap.has(d)).join(", ")}`,
);
console.log(`Subroutines: ${subs.length}, Data types: ${dataTypes.length}, Classes: ${classMap.size}`);
