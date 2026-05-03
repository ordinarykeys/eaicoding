import jingyiRaw from "@/services/agent/knowledge/jingyi-raw.json";

export interface JingyiRawParam {
  name?: string;
  type?: string;
}

export interface JingyiRawItem {
  id?: number;
  name?: string;
  category?: string;
  className?: string;
  returnType?: string;
  params?: JingyiRawParam[];
  description?: string;
}

export interface JingyiRawKnowledge {
  module?: string;
  fetchDate?: string;
  totalItems?: number;
  categories?: Record<string, JingyiRawItem[]>;
}

export interface JingyiSearchItem {
  name: string;
  category: string;
  class_name: string;
  return_type: string;
  signature: string;
  description: string;
  params: Array<{
    name: string;
    type: string;
    attributes?: string;
    description?: string;
  }>;
}

export function publicJingyiParams(params: JingyiRawParam[] | undefined): Array<{ name: string; type: string }> {
  if (!Array.isArray(params)) return [];
  const publicParams: Array<{ name: string; type: string }> = [];

  for (const param of params) {
    const name = typeof param.name === "string" ? param.name.trim() : "";
    const type = typeof param.type === "string" ? param.type.trim() : "";
    if (!name && !type) continue;

    // The raw parser sometimes appends local variables to params. Stop at
    // common local-variable markers so signatures stay useful to the model.
    if (
      name.startsWith("局_") ||
      name.startsWith("局") ||
      /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ||
      name === "i" ||
      name === "n" ||
      name === "len"
    ) {
      break;
    }

    publicParams.push({ name, type });
  }

  return publicParams;
}

export function formatJingyiSignature(item: JingyiRawItem): string {
  const name = item.name?.trim() || "未知命令";
  const returnType = item.returnType?.trim() || "无返回值";
  const params = publicJingyiParams(item.params)
    .map((param) => `${param.name}${param.type ? `: ${param.type}` : ""}`)
    .join("，");
  return `${returnType} ${name}（${params}）`;
}

export function flattenJingyiKnowledge(): JingyiSearchItem[] {
  const raw = jingyiRaw as JingyiRawKnowledge;
  const items: JingyiSearchItem[] = [];
  for (const [category, categoryItems] of Object.entries(raw.categories ?? {})) {
    if (!Array.isArray(categoryItems)) continue;
    for (const item of categoryItems) {
      const name = item.name?.trim();
      if (!name) continue;
      const params = publicJingyiParams(item.params);
      items.push({
        name,
        category: item.category?.trim() || category,
        class_name: item.className?.trim() || "",
        return_type: item.returnType?.trim() || "无返回值",
        signature: formatJingyiSignature(item),
        description: item.description?.trim() || "",
        params,
      });
    }
  }
  return items;
}

export const JINGYI_ITEMS = flattenJingyiKnowledge();
