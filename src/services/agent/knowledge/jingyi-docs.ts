import type { JingyiSearchItem } from "@/services/agent/knowledge/jingyi-data";

interface JingyiDocParam {
  name?: string;
  type?: string;
  attributes?: string;
  description?: string;
}

interface JingyiDocItem {
  name?: string;
  category?: string;
  return_type?: string;
  description?: string;
  params?: JingyiDocParam[];
}

type JingyiDocs = Record<string, JingyiDocItem[] | undefined>;

let docsPromise: Promise<JingyiDocs> | null = null;

async function loadDocs(): Promise<JingyiDocs> {
  if (!docsPromise) {
    docsPromise = import("@/services/agent/knowledge/jingyi-docs.json")
      .then((module) => module.default as JingyiDocs)
      .catch(() => ({}));
  }
  return docsPromise;
}

function findDocForItem(
  docs: JingyiDocs,
  item: JingyiSearchItem,
): JingyiDocItem | null {
  const candidates = docs[item.name];
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  return (
    candidates.find((doc) => doc.category === item.category) ??
    candidates.find((doc) => doc.return_type === item.return_type) ??
    candidates[0] ??
    null
  );
}

function enrichJingyiItem(
  docs: JingyiDocs,
  item: JingyiSearchItem,
): JingyiSearchItem {
  const doc = findDocForItem(docs, item);
  if (!doc) return item;

  const params = item.params.map((param) => {
    const docParam = doc.params?.find((entry) => entry.name === param.name);
    if (!docParam) return param;
    return {
      ...param,
      attributes: docParam.attributes?.trim() || undefined,
      description: docParam.description?.trim() || undefined,
    };
  });

  return {
    ...item,
    description: item.description || doc.description?.trim() || "",
    params,
  };
}

export async function enrichJingyiItemsWithDocs<T extends JingyiSearchItem>(
  items: T[],
): Promise<T[]> {
  if (items.length === 0) return items;
  const docs = await loadDocs();
  return items.map((item) => enrichJingyiItem(docs, item) as T);
}
