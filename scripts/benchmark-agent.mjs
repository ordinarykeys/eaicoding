import { performance } from "node:perf_hooks";
import { createServer } from "vite";

const cases = [
  {
    id: "post-implementations",
    query: "帮我写一个POST请求案例",
    expectRoutes: ["网页_访问"],
    expectOptions: ["网页_访问_对象", "网页_访问S"],
  },
  {
    id: "thread-post",
    query: "写个多线程POST案例",
    expectRoutes: ["线程_启动", "网页_访问"],
    expectOptions: ["网页_访问_对象", "网页_访问S"],
  },
  {
    id: "json-parse",
    query: "json解析数组字段",
    expectRoutes: ["类_json"],
    expectOptions: ["解析"],
  },
  {
    id: "image-find-color",
    query: "图片找色找图案例",
    expectRoutes: ["类_识图"],
    expectOptions: ["找图_", "找色"],
  },
];

function routeNames(result) {
  return (result.implementation_options ?? []).map((route) => route.family);
}

function optionNames(result) {
  return (result.implementation_options ?? []).flatMap((route) =>
    (route.primary_options ?? []).map((item) =>
      item.class_name ? `${item.class_name}.${item.name}` : item.name,
    ),
  );
}

function includesAny(items, expected) {
  return expected.every((needle) => items.some((item) => item.includes(needle)));
}

const server = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});

try {
  const tools = await server.ssrLoadModule("/src/services/agent/tools.ts");
  const rows = [];
  let pass = 0;
  for (const item of cases) {
    const started = performance.now();
    const result = await tools.searchJingyiKnowledge(item.query, 12);
    const durationMs = Math.round(performance.now() - started);
    const routes = routeNames(result);
    const options = optionNames(result);
    const ok =
      includesAny(routes, item.expectRoutes) &&
      includesAny(options, item.expectOptions);
    if (ok) pass += 1;
    rows.push({
      id: item.id,
      ok,
      durationMs,
      routes: routes.slice(0, 5),
      options: options.slice(0, 10),
    });
  }

  const summary = {
    passed: pass,
    total: cases.length,
    passRate: pass / cases.length,
    rows,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (pass !== cases.length) process.exitCode = 1;
} finally {
  await server.close();
}
