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

  console.log("OK agent choice continuation");
} finally {
  await server.close();
}
