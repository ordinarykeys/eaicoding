import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null };
globalThis.fixtureIdb = new Map();
const root = process.cwd(),
  temp = await mkdtemp(path.join(tmpdir(), "eaicoding-providers-"));
try {
  await build({
    stdin: {
      contents: `export {createLLMProvider} from './src/services/llm/index'; export {useSettingsStore} from './src/stores/settings'; export {webTools} from './src/services/agent/web-tools'; export {createBonusNoticeController} from './src/lib/account-notices';`,
      resolveDir: root,
      loader: "ts",
    },
    outfile: path.join(temp, "test.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    plugins: [
      {
        name: "idb",
        setup(b) {
          b.onResolve({ filter: /^idb-keyval$/ }, () => ({
            path: "idb",
            namespace: "fixture",
          }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents:
              "export const get=async k=>globalThis.fixtureIdb.get(k);export const set=async(k,v)=>{globalThis.fixtureIdb.set(k,v)};export const del=async k=>globalThis.fixtureIdb.delete(k);export const createStore=()=>({});",
          }));
        },
      },
    ],
  });
  const api = await import(pathToFileURL(path.join(temp, "test.mjs")).href);
  const config = {
    provider: "fixture",
    profileId: "fixture-route",
    protocol: "openai-chat-completions",
    baseUrl: "https://gateway.invalid/prefix/v1",
    apiKey: "",
    model: "fixture-coder",
    maxTokens: 1024,
    temperature: 0.2,
  };
  let latest,
    mode = "text",
    status = 200,
    errorBody = "invalid key",
    official = false;
  const sse = (value) =>
    (value.type ? "event: " + value.type + "\n" : "") +
    "data: " +
    JSON.stringify(value) +
    "\n\n";
  mockIPC(
    async (cmd, args) => {
      if (cmd === "cancel_agent_task") return null;
      if (cmd !== "llm_proxy_stream") return null;
      latest = args.request;
      assert.equal(latest.profileId, official ? undefined : "fixture-route");
      if (official) {
        assert.equal(latest.body.output_config.effort, "high");
        assert.equal(latest.body.thinking.type, "enabled");
      }
      for (const h of [
        "Authorization",
        "authorization",
        "x-api-key",
        "x-goog-api-key",
        "x-dsh-auth-token",
      ])
        assert.equal(latest.headers[h], undefined);
      const id = latest.requestId;
      await emit("llm-proxy-stream-start", {
        requestId: id,
        status,
        statusText: "OK",
        headers: {
          "content-type": latest.url.includes("/converse")
            ? "application/json"
            : "text/event-stream",
        },
      });
      if (status !== 200)
        return { status, statusText: "Rejected", text: errorBody };
      const tool = {
        id: "call-fixture",
        name: "read_file",
        input: { file_path: "D:/fixture/main.epl" },
      };
      let data;
      if (latest.url.includes("/messages")) {
        // Real official thinking responses carry reasoning before text/tools.
        const offset = official ? 1 : 0;
        data =
          sse({
            type: "message_start",
            message: {
              id: "msg-fixture",
              type: "message",
              role: "assistant",
              model: config.model,
              content: [],
              stop_reason: null,
              usage: { input_tokens: 8, output_tokens: 0 },
            },
          }) +
          (official ?
            sse({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "先检查" } }) +
            sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "真实工具证据。" } }) +
            sse({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fixture-" } }) +
            sse({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } }) +
            sse({ type: "content_block_stop", index: 0 }) : "") +
          sse({
            type: "content_block_start",
            index: offset,
            content_block:
              mode === "tool"
                ? { type: "tool_use", ...tool }
                : { type: "text", text: "" },
          }) +
          sse({
            type: "content_block_delta",
            index: offset,
            delta:
              mode === "tool"
                ? {
                    type: "input_json_delta",
                    partial_json: '{"file_path":"D:/fixture/main.epl"}',
                  }
                : { type: "text_delta", text: "已完成。" },
          }) +
          sse({ type: "content_block_stop", index: offset }) +
          sse({
            type: "message_delta",
            delta: {
              stop_reason:
                mode === "length"
                  ? "max_tokens"
                  : mode === "tool"
                    ? "tool_use"
                    : "end_turn",
            },
            usage: { output_tokens: 4 },
          }) +
          sse({ type: "message_stop" });
      } else if (latest.url.includes("/responses")) {
        const item =
          mode === "tool"
            ? {
                id: "fc-fixture",
                type: "function_call",
                call_id: tool.id,
                name: tool.name,
                arguments: JSON.stringify(tool.input),
                status: "completed",
              }
            : {
                id: "msg-fixture",
                type: "message",
                role: "assistant",
                content: [
                  { type: "output_text", text: "已完成。", annotations: [] },
                ],
              };
        data =
          sse({
            type: "response.created",
            response: {
              id: "resp-fixture",
              model: config.model,
              status: "in_progress",
              output: [],
            },
          }) +
          sse({
            type: "response.output_item.added",
            output_index: 0,
            item:
              mode === "tool"
                ? { ...item, arguments: "" }
                : { ...item, content: [] },
          }) +
          (mode === "tool"
            ? sse({
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: item.id,
                delta: item.arguments,
              })
            : sse({
                type: "response.content_part.added",
                item_id: item.id,
                output_index: 0,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
              }) +
              sse({
                type: "response.output_text.delta",
                item_id: item.id,
                output_index: 0,
                content_index: 0,
                delta: "已完成。",
              })) +
          sse({ type: "response.output_item.done", output_index: 0, item }) +
          sse({
            type:
              mode === "length" ? "response.incomplete" : "response.completed",
            response: {
              id: "resp-fixture",
              model: config.model,
              status: mode === "length" ? "incomplete" : "completed",
              incomplete_details:
                mode === "length" ? { reason: "max_output_tokens" } : undefined,
              output: [item],
              usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
            },
          });
      } else if (latest.url.includes(":streamGenerateContent")) {
        data = sse({
          candidates: [
            {
              content: {
                parts:
                  mode === "tool"
                    ? [{ functionCall: { name: tool.name, args: tool.input } }]
                    : [{ text: "已完成。" }],
              },
              finishReason: mode === "length" ? "MAX_TOKENS" : "STOP",
            },
          ],
        });
      } else if (latest.url.includes("/converse")) {
        data = JSON.stringify({
          output: {
            message: {
              content:
                mode === "tool"
                  ? [
                      {
                        toolUse: {
                          toolUseId: tool.id,
                          name: tool.name,
                          input: tool.input,
                        },
                      },
                    ]
                  : [{ text: "已完成。" }],
            },
          },
          stopReason:
            mode === "length"
              ? "max_tokens"
              : mode === "tool"
                ? "tool_use"
                : "end_turn",
        });
      } else {
        data =
          sse({
            id: "completion-fixture",
            choices: [
              {
                index: 0,
                delta:
                  mode === "tool"
                    ? {
                        tool_calls: [
                          {
                            index: 0,
                            id: tool.id,
                            type: "function",
                            function: {
                              name: tool.name,
                              arguments: JSON.stringify(tool.input),
                            },
                          },
                        ],
                      }
                    : { role: "assistant", content: "已完成。" },
                finish_reason: null,
              },
            ],
          }) +
          sse({
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason:
                  mode === "length"
                    ? "length"
                    : mode === "tool"
                      ? "tool_calls"
                      : "stop",
              },
            ],
            usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
          }) +
          "data: [DONE]\n\n";
      }
      // Fragment the byte stream, including JSON and multi-byte Chinese boundaries.
      for (let i = 0; i < data.length; i += 13)
        await emit("llm-proxy-stream-chunk", {
          requestId: id,
          text: data.slice(i, i + 13),
        });
      return { status: 200, statusText: "OK", text: data };
    },
    { shouldMockEvents: true },
  );
  // Work around the mock's stale args.id field; production event API sends eventId.
  const mockInvoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = (cmd, args, options) =>
    mockInvoke(
      cmd,
      cmd === "plugin:event|unlisten" ? { ...args, id: args.eventId } : args,
      options,
    );

  async function run(protocol, history = []) {
    let text = "",
      calls = [],
      metadata,
      error,
      complete = false;
    official = protocol === "deepseek-messages";
    const provider = api.createLLMProvider(
      official
        ? {
            ...config,
            provider: "deepseek",
            profileId: undefined,
            protocol: "anthropic-messages",
            baseUrl: "https://api.deepseek.com/anthropic",
            reasoningEffort: "high",
          }
        : { ...config, protocol },
    );
    await provider.stream(
      [...history, { id: "u", role: "user", content: "你好", timestamp: 1 }],
      {
        onToken: (t) => (text += t),
        onToolCall: (c) => calls.push(c),
        onComplete: (_, m) => {
          metadata = m;
          complete = true;
        },
        onError: (e) => (error = e),
      },
      {
        tools: [
          {
            name: "read_file",
            description: "Read",
            parameters: {
              type: "object",
              properties: { file_path: { type: "string" } },
              required: ["file_path"],
            },
          },
        ],
      },
    );
    return { text, calls, metadata, error, complete };
  }
  for (const protocol of [
    "openai-chat-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
    "bedrock-converse",
    "deepseek-messages",
  ]) {
    mode = "text";
    const result = await run(protocol);
    assert.ifError(result.error);
    assert.equal(result.text, "已完成。");
    assert(result.complete);
    assert.equal(result.calls.length, 0);
    mode = "tool";
    const tool = await run(protocol);
    assert.ifError(tool.error);
    assert.equal(tool.calls[0].name, "read_file");
    assert.deepEqual(tool.calls[0].arguments, {
      file_path: "D:/fixture/main.epl",
    });
    const history = [
      {
        id: "a",
        role: "assistant",
        content: "",
        toolCalls: tool.calls,
        providerMessage: tool.metadata?.providerMessage,
        timestamp: 2,
      },
      {
        id: "t",
        role: "tool",
        content: "真实源码",
        toolCallId: tool.calls[0].id,
        toolName: "read_file",
        timestamp: 3,
      },
    ];
    mode = "text";
    assert.ifError((await run(protocol, history)).error);
    assert(JSON.stringify(latest.body).includes("真实源码"));
    mode = "length";
    const truncated = await run(protocol);
    assert.equal(truncated.error?.name, "LLMOutputLimitError");
    assert.equal(truncated.calls.length, 0);
    assert(!truncated.complete);
  }
  mode = "text";
  const foreign = {
    id: "foreign",
    role: "assistant",
    content: "此前的答复",
    timestamp: 1,
    providerMessage: {
      role: "assistant",
      geminiContent: { role: "model", parts: [{ text: "此前的答复" }] },
      geminiModel: "other-model",
    },
  };
  assert.ifError((await run("openai-chat-completions", [foreign])).error);
  console.log("PASS provider switches ignore incompatible replay envelopes");
  status = 401;
  mode = "text";
  const rejected = await run("anthropic-messages");
  assert(rejected.error);
  assert(!rejected.complete);
  status = 200;
  const empty = { id: "empty", role: "assistant", content: "", timestamp: 0 };
  assert.ifError((await run("deepseek-messages", [empty])).error);
  assert(latest.body.messages.every(message => message.content.length > 0), "skip empty history messages, as Harness does");
  const replayHistory = [
    { id: "a", role: "assistant", content: "执行当前工具", timestamp: 1,
      toolCalls: [{ id: "current-call", name: "read_file", arguments: { file_path: "current.epl" } }],
      providerMessage: { deepseekModel: config.model, deepseekBlocks: [
        { type: "thinking", thinking: "原生推理", signature: "fixture-signature" },
        { type: "text", text: "已被修改的旧文本" },
        { type: "tool_use", id: "stale-call", name: "read_file", input: { file_path: "old.epl" } },
      ] } },
    { id: "t", role: "tool", toolCallId: "current-call", content: "工具结果", timestamp: 2 },
  ];
  assert.ifError((await run("deepseek-messages", replayHistory)).error);
  const replay = latest.body.messages[0].content;
  assert.deepEqual(replay.map(block => block.type), ["thinking", "text", "tool_use"]);
  assert.equal(replay[0].signature, "fixture-signature");
  assert.equal(replay[1].text, "执行当前工具");
  assert.equal(replay[2].id, "current-call", "stale replay cannot replace live tool calls");
  mode = "tool";
  const thinkingTool = await run("deepseek-messages");
  assert.ifError(thinkingTool.error);
  assert.equal(thinkingTool.metadata.reasoningContent, "先检查真实工具证据。");
  const thinkingHistory = JSON.parse(JSON.stringify([
    { id: "thinking", role: "assistant", content: "", timestamp: 1, toolCalls: thinkingTool.calls, ...thinkingTool.metadata },
    { id: "result", role: "tool", toolCallId: thinkingTool.calls[0].id, content: "保留真实结果", timestamp: 2 },
  ]));
  mode = "text";
  assert.ifError((await run("deepseek-messages", thinkingHistory)).error);
  assert.deepEqual(latest.body.messages[0].content[0], { type: "thinking", thinking: "先检查真实工具证据。", signature: "fixture-signed" });
  for (const metadata of [undefined, { deepseekModel: "different-model", deepseekBlocks: thinkingTool.metadata.providerMessage.deepseekBlocks }, { deepseekModel: config.model, deepseekBlocks: "broken" }]) {
    const degraded = JSON.parse(JSON.stringify(thinkingHistory));
    degraded[0].providerMessage = metadata;
    assert.ifError((await run("deepseek-messages", degraded)).error);
    assert.deepEqual(latest.body.messages[0].content[0], { type: "thinking", thinking: "先检查真实工具证据。" }, "durable reasoning survives absent/foreign/malformed replay without reusing its signature");
    assert.equal(latest.body.messages[0].content.at(-1).id, thinkingTool.calls[0].id);
  }
  console.log("PASS real signed thinking/tool SSE, JSON persistence and durable reasoning after native replay degrades");
  const beforeInvalid = latest;
  assert.match((await run("deepseek-messages", [replayHistory[1]])).error.message, /缺少对应调用/);
  assert.equal(latest, beforeInvalid, "reject unmatched tool history before network I/O");
  status = 400;
  errorBody = JSON.stringify({ error: { type: "invalid_request_error", message: "messages.1.content: invalid tool_use_id (Bearer fixture-secret sk-fixturesecret)" } });
  const invalidRequest = await run("deepseek-messages");
  assert.equal(invalidRequest.error.status, 400);
  assert.match(invalidRequest.error.message, /messages.1.content: invalid tool_use_id/);
  assert(!/fixture-secret|sk-fixturesecret/.test(invalidRequest.error.message));
  assert.equal(invalidRequest.error.retryable, false);
  assert(!invalidRequest.complete && invalidRequest.calls.length === 0);
  status = 200;
  console.log("PASS DeepSeek empty history, current tool replay with signed thinking, preflight validation and redacted HTTP 400 details");
  console.log(
    "PASS five provider protocols plus official DeepSeek Messages, real SDK stream/tool parsing, replay, truncation and credential-free transport",
  );
  // Same Harness notice controller: expiry, head promotion and stale-account isolation.
  clearMocks();
  for (const finish of ["stop", "length", "missing"]) {
    mockIPC(async (cmd, args) => {
      if (cmd !== "model_runtime_run") return null;
      assert.equal(args.profileId, "fixture-route");
      assert.equal(args.input.credential, undefined);
      assert.equal(args.input.provider, undefined);
      await emit("model-runtime-event", { requestId: "other-request", event: { type: "text_delta", delta: "wrong" } });
      await emit("model-runtime-event", { requestId: args.requestId, event: { type: "text_delta", delta: "fixture native" } });
      if (finish !== "missing") await emit("model-runtime-event", { requestId: args.requestId, event: { type: "done", message: { role: "assistant", stopReason: finish, content: [{ type: "toolCall", id: "native-call", name: "read_file", arguments: { path: "fixture" } }] } } });
      return { completed: true };
    }, { shouldMockEvents: true });
    const native = api.createLLMProvider({ ...config, protocol: "pi-ai", modelMetadata: { api: "openai-responses" } });
    const calls = []; let answer, error, text = "";
    await native.stream([{ id: "native-input", role: "user", content: "hello", timestamp: 1 }], { onToken: token => { text += token; }, onToolCall: call => calls.push(call), onComplete: value => { answer = value; }, onError: value => { error = value; } });
    assert.equal(text, "fixture native");
    if (finish === "stop") { assert.equal(answer, text); assert.equal(calls.length, 1); assert.equal(error, undefined); }
    else { assert(error); assert.equal(answer, undefined); assert.equal(calls.length, 0); }
    clearMocks();
  }
  console.log("PASS native SDK provider transport isolates requests and gates tools on complete, untruncated responses");
  let published = [],
    batch = {
      accountId: "A",
      bonuses: [
        { orderId: "expired", message: "old", expiresAt: "2000-01-01" },
        { orderId: "one", title: "", message: "first", expiresAt: "" },
        { orderId: "two", message: "second", expiresAt: "" },
      ],
    };
  const acks = [];
  const controller = api.createBonusNoticeController({
    ackRetryDelayMs: 1,
    ackRetryMaxDelayMs: 5,
    read: async () => batch,
    acknowledge: async (a, o) => {
      acks.push([a, o]);
      return true;
    },
    publish: (n) => (published = n),
  });
  controller.begin();
  await controller.refresh();
  assert.deepEqual(
    published.map((n) => n.orderId),
    ["one", "two"],
  );
  controller.shown("one");
  controller.dismiss("one");
  assert.equal(published[0].orderId, "two");
  controller.shown("two");
  for (let i = 0; i < 100 && acks.length < 2; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(acks, [
    ["A", "one"],
    ["A", "two"],
  ]);
  controller.end();
  assert.equal(published.length, 0);
  console.log(
    "PASS account notice expiry, empty titles, stacked dismissal, acknowledgements and logout cleanup",
  );
} finally {
  clearMocks();
  await rm(temp, { recursive: true, force: true });
}
