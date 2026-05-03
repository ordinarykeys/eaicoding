#!/usr/bin/env node
/**
 * Fetch 精易模块 API documentation from ec.ijingyi.com.
 *
 * 1. Reads the local sub.htm to extract the dTree node IDs + names.
 * 2. For every leaf node, POSTs to the server to get detailed HTML.
 * 3. Parses each HTML snippet to extract subroutine signatures.
 * 4. Writes the result to src/services/agent/knowledge/jingyi-raw.json.
 *
 * Usage:  node scripts/fetch-jingyi-kb.mjs [path-to-sub.htm]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// 1. Parse the dTree from sub.htm
// ---------------------------------------------------------------------------

const subHtmPath =
  process.argv[2] ||
  path.resolve(
    PROJECT_ROOT,
    "..",
    "ec.ijingyi.com",
    "ec.ijingyi.com",
    "sub.htm",
  );

if (!fs.existsSync(subHtmPath)) {
  console.error(`sub.htm not found at: ${subHtmPath}`);
  console.error(
    "Usage: node scripts/fetch-jingyi-kb.mjs [path-to-sub.htm]",
  );
  process.exit(1);
}

console.log(`Reading ${subHtmPath} ...`);
const html = fs.readFileSync(subHtmPath, "utf-8");

// Extract d.add(id, parentId, "name", ...) calls
const addRe = /d\.add\((\d+)\s*,\s*(\d+)\s*,\s*"([^"]+)"/g;
const nodes = []; // { id, parentId, name }
let m;
while ((m = addRe.exec(html)) !== null) {
  nodes.push({ id: Number(m[1]), parentId: Number(m[2]), name: m[3] });
}
console.log(`Found ${nodes.length} tree nodes.`);

// Build parent→children map
const childMap = new Map(); // parentId → [node, ...]
for (const n of nodes) {
  if (!childMap.has(n.parentId)) childMap.set(n.parentId, []);
  childMap.get(n.parentId).push(n);
}

// Top-level categories are children of node 1 (精易模块)
const CATEGORY_IDS = new Map(); // id → category name
const topCategories = childMap.get(1) || [];
for (const cat of topCategories) {
  CATEGORY_IDS.set(cat.id, cat.name);
}
console.log(
  `Categories: ${[...CATEGORY_IDS.values()].join(", ")}`,
);

// Collect leaf nodes (those that are NOT parents of other nodes)
const parentIds = new Set(nodes.map((n) => n.parentId));
// But we also want class method nodes (children of class nodes under category 8 "类")
// A "leaf" is any node whose id is NOT in parentIds — meaning nothing else has it as parentId
const leafNodes = nodes.filter((n) => !childMap.has(n.id));
console.log(`Leaf nodes to fetch: ${leafNodes.length}`);

// Resolve category for each leaf
function resolveCategory(node) {
  let current = node;
  const visited = new Set();
  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    if (CATEGORY_IDS.has(current.id)) return CATEGORY_IDS.get(current.id);
    // find parent
    current = nodes.find((n) => n.id === current.parentId);
  }
  return "未知";
}

// For class nodes, resolve the class name (direct parent under category 8)
function resolveClassName(node) {
  let current = node;
  const visited = new Set();
  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    if (current.parentId === 8) return current.name; // direct child of 类
    current = nodes.find((n) => n.id === current.parentId);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. Fetch detailed info from API
// ---------------------------------------------------------------------------

const API_URL = "https://ec.ijingyi.com/plugin.php?id=plugin1&";
const DELAY_MS = 80; // polite rate-limit

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchDetail(id) {
  const body = new URLSearchParams({ mod: "sub", ac: "getdata", num: String(id) });
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for id=${id}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// 3. Parse HTML to extract parameter info
// ---------------------------------------------------------------------------

function parseDetailHtml(htmlStr) {
  // The HTML contains tables with class-marked cells:
  //   td.eProcolor  → subroutine name
  //   td.eTypecolor → return type
  //   td.Variablescolor → parameter name
  //   followed by sibling td → parameter type
  // Also look for description text

  const result = { name: "", returnType: "", params: [], description: "" };

  // Extract subroutine name
  const nameMatch = htmlStr.match(
    /<td[^>]*class=["']?eProcolor["']?[^>]*>([^<]+)</i,
  );
  if (nameMatch) result.name = nameMatch[1].trim();

  // Extract return type
  const retMatch = htmlStr.match(
    /<td[^>]*class=["']?eTypecolor["']?[^>]*>([^<]+)</i,
  );
  if (retMatch) result.returnType = retMatch[1].trim();

  // Extract parameters: each row has Variablescolor (param name) then next td (type)
  const paramRe =
    /<td[^>]*class=["']?Variablescolor["']?[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]*)<\/td>/gi;
  let pm;
  while ((pm = paramRe.exec(htmlStr)) !== null) {
    result.params.push({
      name: pm[1].trim(),
      type: pm[2].trim(),
    });
  }

  // Extract description (look for eMarkcolor or remark text)
  const descMatch = htmlStr.match(
    /<td[^>]*class=["']?eMarkcolor["']?[^>]*>([^<]+)</i,
  );
  if (descMatch) result.description = descMatch[1].trim();

  // Also try to find data type members (for 数据类型)
  // Members are in rows: td.Variablescolor (member name), td (type), td.eMarkcolor (remark)
  const memberRe =
    /<td[^>]*class=["']?Variablescolor["']?[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*class=["']?eMarkcolor["']?[^>]*>([^<]*)<\/td>/gi;
  const members = [];
  let mm;
  while ((mm = memberRe.exec(htmlStr)) !== null) {
    members.push({
      name: mm[1].trim(),
      type: mm[2].trim(),
      remark: mm[3].trim(),
    });
  }
  if (members.length > 0) result.members = members;

  return result;
}

// ---------------------------------------------------------------------------
// 4. Main
// ---------------------------------------------------------------------------

const OUTPUT_PATH = path.resolve(
  PROJECT_ROOT,
  "src",
  "services",
  "agent",
  "knowledge",
  "jingyi-raw.json",
);

// Check for existing progress file to support resumption
const progressPath = OUTPUT_PATH + ".progress.json";
let existing = {};
if (fs.existsSync(progressPath)) {
  console.log("Found progress file, resuming...");
  existing = JSON.parse(fs.readFileSync(progressPath, "utf-8"));
}

async function main() {
  const results = { ...existing };
  let fetched = 0;
  let skipped = 0;
  let errors = 0;

  for (const leaf of leafNodes) {
    const key = String(leaf.id);
    if (results[key]) {
      skipped++;
      continue;
    }

    try {
      const data = await fetchDetail(leaf.id);
      const category = resolveCategory(leaf);
      const className = resolveClassName(leaf);

      let detail = { name: leaf.name, category };
      if (className) detail.className = className;

      if (data.result && data.data && data.data.content) {
        const parsed = parseDetailHtml(data.data.content);
        detail = { ...detail, ...parsed };
        // Keep the tree name if parsed name is empty
        if (!detail.name) detail.name = leaf.name;
      } else {
        detail.fetchError = "no content in response";
      }

      results[key] = detail;
      fetched++;

      if (fetched % 50 === 0) {
        console.log(
          `  Progress: ${fetched} fetched, ${skipped} skipped, ${errors} errors (total ${Object.keys(results).length}/${leafNodes.length})`,
        );
        // Save progress
        fs.writeFileSync(progressPath, JSON.stringify(results, null, 2), "utf-8");
      }
    } catch (err) {
      console.error(`  Error fetching id=${leaf.id} (${leaf.name}): ${err.message}`);
      results[key] = {
        name: leaf.name,
        category: resolveCategory(leaf),
        fetchError: err.message,
      };
      errors++;
    }

    await sleep(DELAY_MS);
  }

  // Final save
  console.log(
    `\nDone: ${fetched} fetched, ${skipped} skipped, ${errors} errors.`,
  );

  // Organize by category
  const organized = {};
  for (const [id, detail] of Object.entries(results)) {
    const cat = detail.category || "未知";
    if (!organized[cat]) organized[cat] = [];
    organized[cat].push({ id: Number(id), ...detail });
  }

  // Sort items within each category by name
  for (const cat of Object.keys(organized)) {
    organized[cat].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  const output = {
    module: "精易模块",
    fetchDate: new Date().toISOString(),
    totalItems: Object.keys(results).length,
    categories: organized,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  console.log(`Written to ${OUTPUT_PATH}`);

  // Clean up progress file
  if (fs.existsSync(progressPath)) {
    fs.unlinkSync(progressPath);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
