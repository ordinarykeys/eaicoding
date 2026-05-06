import { createServer } from "vite";

function assert(condition, message, details = "") {
  if (!condition) {
    throw new Error(`${message}${details ? `\n${details}` : ""}`);
  }
}

const repeatedExecutableAnswer = `
\`\`\`epl
.版本 2

.子程序 _启动子程序
启动线程 (&线程POST, 0)
启动线程 (&线程POST, 0)
启动线程 (&线程POST, 0)
启动线程 (&线程POST, 0)
启动线程 (&线程POST, 0)
\`\`\`
`;

const repeatedAssignmentAnswer = `
\`\`\`epl
.版本 2

.子程序 _按钮1_被单击
返回结果 ＝ 网页_访问S (“https://example.com”, 1, post数据, , , 协议头)
返回结果 ＝ 网页_访问S (“https://example.com”, 1, post数据, , , 协议头)
返回结果 ＝ 网页_访问S (“https://example.com”, 1, post数据, , , 协议头)
\`\`\`
`;

const loopThreadAnswer = `
\`\`\`epl
.版本 2

.子程序 _启动子程序
.局部变量 i, 整数型

.计次循环首 (5, i)
    启动线程 (&线程POST, i)
.计次循环尾 ()
\`\`\`
`;

const server = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});

try {
  const mod = await server.ssrLoadModule("/src/services/agent/epl-syntax.ts");

  const repeatedDiagnostics = mod.findEplAnswerDiagnostics(repeatedExecutableAnswer);
  assert(
    repeatedDiagnostics.some(
      (item) =>
        item.kind === "repeated_executable" &&
        item.severity === "warning" &&
        item.message.includes("连续出现 5 次相同可执行语句"),
    ),
    "应把连续重复的可执行语句识别为通用质量信号。",
    JSON.stringify(repeatedDiagnostics, null, 2),
  );

  const repeatedAssignmentDiagnostics = mod.findEplAnswerDiagnostics(repeatedAssignmentAnswer);
  assert(
    repeatedAssignmentDiagnostics.some((item) => item.kind === "repeated_executable"),
    "重复检查不能写死到启动线程；重复网页访问/赋值这类机械复制也应被识别。",
    JSON.stringify(repeatedAssignmentDiagnostics, null, 2),
  );

  const loopDiagnostics = mod.findEplAnswerDiagnostics(loopThreadAnswer);
  assert(
    loopDiagnostics.length === 0,
    "使用计次循环的多线程示例不应触发重复语句诊断。",
    JSON.stringify(loopDiagnostics, null, 2),
  );

  console.log("OK EPL 诊断");
} finally {
  await server.close();
}
