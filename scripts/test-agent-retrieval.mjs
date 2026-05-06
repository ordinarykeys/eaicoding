import { createServer } from "vite";

const contains = (items, predicate) => items.some(predicate);

function routeNames(result) {
  return (result.implementation_options ?? []).map((route) => route.family);
}

function primaryNames(route) {
  return (route?.primary_options ?? []).map((option) =>
    option.class_name ? `${option.name}@${option.class_name}` : option.name,
  );
}

function assert(condition, message, details = "") {
  if (!condition) {
    throw new Error(`${message}${details ? `\n${details}` : ""}`);
  }
}

function describeRoutes(result) {
  return (result.implementation_options ?? [])
    .slice(0, 6)
    .map((route) =>
      `${route.family}[${route.route_type}]: ${primaryNames(route).slice(0, 5).join(", ")}`,
    )
    .join("\n");
}

const cases = [
  {
    query: "帮我写一个POST请求案例",
    check(result) {
      const routes = result.implementation_options ?? [];
      const first = routes[0];
      assert(
        first?.family === "网页_访问",
        "POST 请求案例应该优先返回真正发起网页请求的函数族，而不是 POST 参数构造辅助类。",
        describeRoutes(result),
      );
      assert(
        contains(primaryNames(first), (name) => name === "网页_访问_对象") &&
          contains(primaryNames(first), (name) => name === "网页_访问S"),
        "POST 请求案例应展示网页_访问同族多个实现。",
        describeRoutes(result),
      );
    },
  },
  {
    query: "http post 请求",
    check(result) {
      const routes = result.implementation_options ?? [];
      assert(
        contains(routes, (route) => route.family === "类_XMLHTTP"),
        "HTTP POST 场景应召回对象式 XMLHTTP 调用链。",
        describeRoutes(result),
      );
      const xmlHttp = routes.find((route) => route.family === "类_XMLHTTP");
      assert(
        contains(primaryNames(xmlHttp), (name) => name.includes("发送请求@类_XMLHTTP")) &&
          contains(primaryNames(xmlHttp), (name) => name.includes("打开@类_XMLHTTP")),
        "XMLHTTP 路线应包含打开连接和发送请求这类主调用链证据。",
        describeRoutes(result),
      );
    },
  },
  {
    query: "写个多线程案例",
    check(result) {
      const names = routeNames(result).slice(0, 4);
      assert(
        names.includes("线程_启动") && names.includes("线程_启动多参"),
        "多线程案例应优先返回启动线程相关函数族，而不是许可证/状态查询等辅助 API。",
        describeRoutes(result),
      );
    },
  },
  {
    query: "写个多线程POST案例",
    check(result) {
      const names = routeNames(result).slice(0, 6);
      assert(
        names.includes("线程_启动") && names.includes("网页_访问"),
        "组合功能问题应同时召回线程启动和网页访问两条实现路线。",
        describeRoutes(result),
      );
    },
  },
  {
    query: "json解析数组字段",
    check(result) {
      const first = result.implementation_options?.[0];
      assert(
        first?.family === "类_json",
        "JSON 解析问题应优先返回类_json 调用链。",
        describeRoutes(result),
      );
      assert(
        contains(primaryNames(first), (name) => name.includes("解析@类_json")),
        "类_json 路线应包含解析方法。",
        describeRoutes(result),
      );
    },
  },
  {
    query: "图片找色找图案例",
    check(result) {
      const routes = result.implementation_options ?? [];
      assert(
        contains(routes, (route) => route.family === "类_识图"),
        "找色找图案例应召回类_识图对象路线。",
        describeRoutes(result),
      );
      const imageRoute = routes.find((route) => route.family === "类_识图");
      assert(
        contains(primaryNames(imageRoute), (name) => name.includes("找图_")) &&
          contains(primaryNames(imageRoute), (name) => name.includes("找色@类_识图")),
        "类_识图路线应同时包含找图和找色证据。",
        describeRoutes(result),
      );
    },
  },
];

const server = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});

try {
  const mod = await server.ssrLoadModule("/src/services/agent/tools.ts");
  const choiceMod = await server.ssrLoadModule("/src/services/agent/implementation-choice.ts");
  for (const item of cases) {
    const result = await mod.searchJingyiKnowledge(item.query, 12);
    item.check(result);
    console.log(`OK ${item.query}`);
  }

  const postResult = await mod.searchJingyiKnowledge("帮我写一个POST请求案例", 12);
  const postChoice = choiceMod.createJingyiImplementationChoiceRequest(
    postResult,
    "帮我写一个POST请求案例",
  );
  assert(
    postChoice?.options?.length >= 2,
    "POST 请求案例存在多个网页访问实现时，应先生成用户选择请求。",
    JSON.stringify(postChoice, null, 2),
  );
  assert(
    contains(postChoice.options, (option) => option.label.includes("网页_访问_对象")) &&
      contains(postChoice.options, (option) => option.label.includes("网页_访问S")),
    "POST 请求选择项应包含主要网页访问实现。",
    JSON.stringify(postChoice, null, 2),
  );

  const namedChoice = choiceMod.createJingyiImplementationChoiceRequest(
    postResult,
    "使用网页_访问S帮我写一个POST请求案例",
  );
  assert(
    namedChoice === null,
    "用户已经点名实现方式时，不应再次弹出选择。",
    JSON.stringify(namedChoice, null, 2),
  );

  const multiPostResult = await mod.searchJingyiKnowledge("写个多线程POST案例", 12);
  const multiPostChoice = choiceMod.createJingyiImplementationChoiceRequest(
    multiPostResult,
    "写个多线程POST案例",
  );
  assert(
    multiPostChoice?.options?.length >= 2,
    "多线程 POST 这种组合功能里，只要网页请求路线存在多个主实现，也应先生成用户选择请求。",
    JSON.stringify(multiPostChoice, null, 2),
  );
  assert(
    contains(multiPostChoice.options, (option) => option.label.includes("网页_访问_对象")) &&
      contains(multiPostChoice.options, (option) => option.label.includes("网页_访问S")),
    "多线程 POST 的选择项应包含主要网页访问实现。",
    JSON.stringify(multiPostChoice, null, 2),
  );
  console.log("OK 精易模块实现方式选择");
} finally {
  await server.close();
}
