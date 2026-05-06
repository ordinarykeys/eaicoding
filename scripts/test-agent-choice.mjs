import { createServer } from "vite";

function assert(condition, message, details = "") {
  if (!condition) {
    throw new Error(`${message}${details ? `\n${details}` : ""}`);
  }
}

const server = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});

try {
  const runner = await server.ssrLoadModule("/src/services/agent/runner.ts");
  const tools = await server.ssrLoadModule("/src/services/agent/tools.ts");
  const pendingChoice = {
    question: "请选择实现方式",
    options: [
      { label: "网页_访问", value: "网页_访问" },
      { label: "网页_访问_对象", value: "网页_访问_对象" },
      { label: "网页_访问S", value: "网页_访问S" },
    ],
    allowCustom: true,
  };
  const history = [
    {
      id: "u1",
      role: "user",
      content: "帮我写个多线程POST案例",
      timestamp: 1,
    },
    {
      id: "a1",
      role: "assistant",
      content: "请选择一个实现方式",
      timestamp: 2,
      agentTrace: {
        goal: "帮我写个多线程POST案例",
        steps: [],
        finalAnswer: "请选择一个实现方式",
        outcome: "needs_input",
        pendingUserChoice: pendingChoice,
        startedAt: 0,
        endedAt: 0,
        toolCallCount: 0,
      },
    },
  ];

  const latestPending = runner.getLatestPendingUserChoice(history);
  assert(
    latestPending?.question === pendingChoice.question,
    "Pending choice should be recoverable from the previous assistant turn.",
    JSON.stringify(latestPending, null, 2),
  );

  const selected = runner.describeSelectedImplementationFromChoice(
    "我选网页_访问_对象",
    history,
  );
  assert(
    selected === "网页_访问_对象",
    "Choice matching should prefer the most specific option over a short prefix.",
    selected,
  );

  const evidenceQuery = runner.buildSelectedImplementationEvidenceQuery(
    "我选网页_访问_对象",
    history,
  );
  assert(
    evidenceQuery.includes("网页_访问_对象"),
    "Choice continuation should build a knowledge query for the selected implementation.",
    evidenceQuery,
  );
  assert(
    evidenceQuery.includes("帮我写个多线程POST案例"),
    "Choice continuation should preserve the original user goal in the evidence query.",
    evidenceQuery,
  );

  const plainInputQuery = runner.buildSelectedImplementationEvidenceQuery(
    "网页_访问_对象",
    history,
  );
  assert(
    plainInputQuery.includes("网页_访问_对象"),
    "Exact chip label should also continue with the selected implementation.",
    plainInputQuery,
  );

  assert(
    runner.answerLooksLikeClarificationOnly(`你要哪种多线程 POST 案例？

1. 最简单表单 POST
2. JSON POST
3. 带请求头的 POST

你直接回复数字或类型名，我就按那个给你完整示例。`),
    "Plain-text option prompts should be detected as clarification-only, not final answers.",
  );
  assert(
    !runner.answerLooksLikeClarificationOnly(`下面给你一个示例：

\`\`\`epl
.版本 2
.程序集 窗口程序集_启动窗口
.子程序 _按钮1_被单击
    调试输出 (“开始”)
\`\`\``),
    "Real EPL code answers should not be treated as clarification-only.",
  );

  const uploadedModuleInput = [
    "用户上传了以下本地文件，请用工具读取后再分析（.e/.ec 用 parse_efile，文本文件用 read_file）：",
    "- C:\\Users\\pingfan\\Desktop\\鱼刺类.多线程6.ec （.ec 模块文件，可用 parse_efile 读取公开接口）",
    "",
    "用户补充说明：用这个模块写个多线程POST案例",
  ].join("\n");
  assert(
    runner
      .extractLocalFilePathsByExtension(uploadedModuleInput, ["ec"])
      .some((item) => item.endsWith("鱼刺类.多线程6.ec")),
    "Uploaded .ec path should be extracted from the generated upload block.",
  );
  assert(
    runner.getUploadedEcModuleParseTargets(uploadedModuleInput).length === 1,
    "A user-requested uploaded .ec module should be selected for parse_efile before Jingyi retrieval.",
    JSON.stringify(runner.getUploadedEcModuleParseTargets(uploadedModuleInput), null, 2),
  );

  const followupUploadedRun = runner.startAgentRun({
    config: {
      provider: "openai",
      protocol: "openai-chat-completions",
      apiKey: "test",
      baseUrl: "http://127.0.0.1/unused",
      model: "unused",
      maxTokens: 256,
      temperature: 0,
    },
    userInput: "用这个模块写个多线程POST案例",
    history: [
      {
        id: "upload_ec",
        role: "user",
        content: uploadedModuleInput,
        timestamp: 3,
      },
    ],
    sessionId: null,
    maxSteps: 1,
    allowDialog: false,
  });
  const followupUploadedTrace = await followupUploadedRun.promise;
  assert(
    followupUploadedTrace.steps[0]?.toolCalls[0]?.name === "parse_efile",
    "A follow-up that says 'use this module' should reuse the latest uploaded .ec path from history.",
    JSON.stringify(followupUploadedTrace.steps[0], null, 2),
  );

  const yuciLikeOutput = `
.版本 2

*类 为 面向对象 调用。

.程序集 鱼刺类_线程池, , , 鱼刺线程池（面向对象）
.子程序 创建, 逻辑型, 公开, 创建并启动线程池
.参数 参数_线程池容量, 整数型, 可空, 同时工作的线程数
.子程序 投递任务, 逻辑型, 公开, 向线程池里投递任务
.参数 参数_执行函数, 通用型, 参考, 要执行的函数地址
.参数 参数_参数一, 整数型, 可空, 附加参数1
.子程序 等待任务动态, 逻辑型, 公开, 等待有线程任务执行完毕
.参数 参数_等待超时_毫秒, 整数型, 可空, 超时时间
.子程序 销毁, 逻辑型, 公开, 销毁线程池

.程序集 鱼刺类_队列, , , 鱼刺自制队列（面向对象）
.子程序 压入, 逻辑型, 公开, 压入数据
.参数 欲压入的数据指针, 整数型, , 数据指针
.子程序 弹出, 逻辑型, 公开, 弹出数据
`;
  const yuciIndex = tools.extractParsedEFilePublicApis(
    yuciLikeOutput,
    "用这个模块写个多线程POST案例",
    12,
  );
  assert(
    yuciIndex.module_index_mode === "class_oriented",
    "Class-oriented custom modules should expose class-oriented index mode.",
    JSON.stringify(yuciIndex, null, 2),
  );
  assert(
    yuciIndex.preferred_api_groups?.[0]?.class_name === "鱼刺类_线程池",
    "Class-oriented ranking should prefer the thread-pool class for a multithreaded task.",
    JSON.stringify(yuciIndex.preferred_api_groups, null, 2),
  );
  assert(
    yuciIndex.preferred_api_groups?.[0]?.workflow_methods?.some((item) => item.name === "投递任务"),
    "Class-oriented workflow methods should include the relevant action method.",
    JSON.stringify(yuciIndex.preferred_api_groups?.[0], null, 2),
  );

  const flatModuleOutput = `
.版本 2
.程序集 工具程序集, , ,
.子程序 网页请求, 文本型, 公开, 发送网页请求
.参数 URL, 文本型, , 请求地址
.子程序 编码转换, 文本型, 公开, 转换编码
.参数 原文, 文本型, , 原文本
`;
  const flatIndex = tools.extractParsedEFilePublicApis(flatModuleOutput, "写个网页请求案例", 8);
  assert(
    flatIndex.module_index_mode === "flat_public_api",
    "Flat custom modules should not be forced into class-oriented usage.",
    JSON.stringify(flatIndex, null, 2),
  );

  const run = runner.startAgentRun({
    config: {
      provider: "openai",
      protocol: "openai-chat-completions",
      apiKey: "test",
      baseUrl: "http://127.0.0.1/unused",
      model: "unused",
      maxTokens: 256,
      temperature: 0,
    },
    userInput: "写个多线程POST案例",
    history: [],
    sessionId: null,
    maxSteps: 4,
    allowDialog: false,
  });
  const trace = await run.promise;
  assert(
    trace.outcome === "needs_input",
    "First turn for a multi-implementation Jingyi example should stop at structured choice before model prose.",
    JSON.stringify({ outcome: trace.outcome, finalAnswer: trace.finalAnswer, pending: trace.pendingUserChoice }, null, 2),
  );
  assert(
    trace.pendingUserChoice?.options?.some((option) => option.label.includes("网页_访问_对象")) &&
      trace.pendingUserChoice?.options?.some((option) => option.label.includes("网页_访问S")),
    "The structured choice should expose the real Jingyi implementation options.",
    JSON.stringify(trace.pendingUserChoice, null, 2),
  );

  const uploadedRun = runner.startAgentRun({
    config: {
      provider: "openai",
      protocol: "openai-chat-completions",
      apiKey: "test",
      baseUrl: "http://127.0.0.1/unused",
      model: "unused",
      maxTokens: 256,
      temperature: 0,
    },
    userInput: uploadedModuleInput,
    history: [],
    sessionId: null,
    maxSteps: 1,
    allowDialog: false,
  });
  const uploadedTrace = await uploadedRun.promise;
  assert(
    uploadedTrace.steps[0]?.toolCalls[0]?.name === "parse_efile",
    "Uploaded custom .ec module should be parsed before any model-generated answer or Jingyi choice.",
    JSON.stringify(uploadedTrace.steps[0], null, 2),
  );
  assert(
    !uploadedTrace.steps[0]?.toolCalls.some((call) => call.name === "search_jingyi_module"),
    "Uploaded custom .ec module should not be replaced by the Jingyi knowledge primer.",
    JSON.stringify(uploadedTrace.steps[0]?.toolCalls, null, 2),
  );
  assert(
    runner.answerDeflectsAfterUploadedModuleParse(
      uploadedModuleInput,
      "parse_efile 返回内容过大且被截断，先让用户选定实现路线；目前缺少该模块公开接口的精确命令名证据，不能硬编造 API。",
      {
        goal: uploadedModuleInput,
        steps: [
          {
            index: 1,
            assistantText: "先解析模块",
            toolCalls: [
              {
                id: "tc_parse",
                name: "parse_efile",
                arguments: { target_path: "C:\\Users\\pingfan\\Desktop\\鱼刺类.多线程6.ec" },
                rawArguments: "{}",
              },
            ],
            toolResults: [
              {
                toolCallId: "tc_parse",
                toolName: "parse_efile",
                ok: true,
                content: {
                  success: true,
                  public_api_index: {
                    total_public_api_count: 3,
                    items: [{ name: "投递任务", signature: "鱼刺类_线程池.投递任务(...)" }],
                  },
                },
                durationMs: 1,
              },
            ],
            finishReason: "tool_call",
            startedAt: 0,
            endedAt: 1,
          },
        ],
        finalAnswer: "",
        outcome: "answer",
        startedAt: 0,
        endedAt: 1,
        toolCallCount: 1,
      },
    ),
    "A deflecting answer after uploaded module parse should be rejected so the agent continues with public_api_index evidence.",
  );

  console.log("OK agent choice continuation");
} finally {
  await server.close();
}
