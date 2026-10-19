import { nanoid } from "nanoid";
import type { UserModuleApi, UserModuleAssembly, ModuleDeclaration } from "./module-library";

function trimCell(value: string | undefined): string {
  return (value ?? "").trim();
}

function splitFields(line: string, prefix: string): string[] {
  const body = line.slice(prefix.length).trim();
  const fields: string[] = [];
  let cell = "", quoted = false;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === '"') {
      if (quoted && body[index + 1] === '"') { cell += '""'; index++; continue; }
      quoted = !quoted;
    }
    if (char === "," && !quoted) { fields.push(trimCell(cell)); cell = ""; }
    else cell += char;
  }
  fields.push(trimCell(cell));
  return fields;
}

function buildSignature(api: UserModuleApi): string {
  const params = api.params
    .map((param) => {
      const annotations: string[] = [];
      if (param.array) annotations.push("数组");
      if (param.byRef) annotations.push("传址");
      if (param.optional) annotations.push("可空");
      const tail = annotations.length > 0 ? ` (${annotations.join("/")})` : "";
      return `${param.name}: ${param.type || "?"}${tail}`;
    })
    .join("，");
  const ret = api.returnType || (api.kind === "subprogram" ? "无返回值" : "");
  return `${ret} ${api.name}（${params}）`.trim();
}

export function parseRawModuleApis(parsedText: string, onProgress?: (done: number, total: number) => void): {
  apis: UserModuleApi[];
  assemblies: UserModuleAssembly[];
  declarations: ModuleDeclaration[];
} {
  const lines = parsedText.replace(/\r\n/g, "\n").split("\n");
  const apis: UserModuleApi[] = [];
  const declarations: ModuleDeclaration[] = [];
  const assemblies = new Map<string, UserModuleAssembly>();
  let currentAssembly = "";
  let currentAssemblyDescription = "";
  let current: UserModuleApi | null = null;

  const finishCurrent = () => {
    if (!current) return;
    current.signature = buildSignature(current);
    apis.push(current);
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    if (index % 4096 === 0) onProgress?.(index, lines.length);
    const line = (lines[index] ?? "").trim();
    const declaration = line.match(/^\.(数据类型|常量|全局变量|图片|声音|程序集变量|成员)\s+(.+)/);
    if (declaration) {
      if (declaration[1] === "数据类型") finishCurrent();
      const fields = splitFields(line, "." + declaration[1]);
      declarations.push({ kind: declaration[1], name: fields[0], signature: line, line: index + 1 });
    }
    if (!line) continue;

    if (/^\.程序集(?:\s|$)/.test(line)) {
      finishCurrent();
      const fields = splitFields(line, ".程序集");
      currentAssembly = fields[0] || currentAssembly;
      currentAssemblyDescription = fields.slice(3).filter(Boolean).join("，");
      if (currentAssembly && !assemblies.has(currentAssembly)) {
        assemblies.set(currentAssembly, {
          name: currentAssembly,
          line: index + 1,
          description: currentAssemblyDescription,
          publicMethodCount: 0,
        });
      }
      continue;
    }

    if (line.startsWith(".子程序")) {
      finishCurrent();
      const fields = splitFields(line, ".子程序");
      const attr = fields[2] || "";
      current = {
        id: nanoid(8),
        kind: "subprogram",
        name: fields[0] || "",
        className: currentAssembly,
        returnType: fields[1] || "",
        description: fields.slice(3).filter(Boolean).join("，"),
        line: index + 1,
        params: [],
        signature: "",
        isPublic: attr.includes("公开"),
      };
      continue;
    }

    if (line.startsWith(".DLL命令")) {
      finishCurrent();
      const fields = splitFields(line, ".DLL命令");
      current = {
        id: nanoid(8),
        kind: "dll",
        name: fields[0] || "",
        className: currentAssembly,
        returnType: fields[1] || "",
        description: fields.slice(5).filter(Boolean).join("，"),
        line: index + 1,
        params: [],
        signature: "",
        isPublic: false,
      };
      continue;
    }

    if (line.startsWith(".参数") && current) {
      const fields = splitFields(line, ".参数");
      const attr = fields[2] || "";
      current.params.push({
        name: fields[0] || `参数${current.params.length + 1}`,
        type: fields[1] || "",
        array: attr.includes("数组"),
        byRef: attr.includes("参考") || attr.includes("传址"),
        optional: attr.includes("可空"),
        description: fields.slice(3).filter(Boolean).join("，"),
      });
    }
  }
  finishCurrent();
  onProgress?.(lines.length, lines.length);

  for (const api of apis) {
    if (!api.isPublic || !api.className) continue;
    const info = assemblies.get(api.className);
    if (info) info.publicMethodCount += 1;
  }

  return {
    apis,
    declarations,
    assemblies: Array.from(assemblies.values()).sort((a, b) => a.line - b.line),
  };
}
