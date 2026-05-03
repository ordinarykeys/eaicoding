/**
 * EplRenderer — D:\e 易语言 IDE 风格的表格化高亮
 *
 * 把 .程序集 / .子程序 / .局部变量 / .参数 / .全局变量 / .常量 等声明行
 * 解析成 IDE 里的多列表格，普通代码行用流程线图标和 token 着色渲染。
 */

import { useLayoutEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Tokenizer (unchanged from before — used for code lines)
// ---------------------------------------------------------------------------

type TokenKind =
  | "directive"
  | "type"
  | "string"
  | "number"
  | "comment"
  | "keyword"
  | "api"
  | "punct"
  | "ident"
  | "space";

interface Tok {
  kind: TokenKind;
  text: string;
}

const EPL_KEYWORDS = new Set([
  "如果",
  "如果真",
  "否则",
  "如果结束",
  "如果真结束",
  "返回",
  "判断",
  "判断开始",
  "判断结束",
  "判断循环首",
  "判断循环尾",
  "选择",
  "情况",
  "默认",
  "循环判断首",
  "循环判断尾",
  "计次循环首",
  "计次循环尾",
  "变量循环首",
  "变量循环尾",
  "跳出循环",
  "到循环尾",
  "真",
  "假",
  "空",
]);

const EPL_TYPES = new Set([
  "整数型",
  "长整数型",
  "短整数型",
  "字节型",
  "小数型",
  "双精度小数型",
  "逻辑型",
  "日期时间型",
  "文本型",
  "字节集",
  "通用型",
  "子程序指针",
  "对象",
  "类",
]);

const EPL_PUNCTUATION = new Set([
  ",",
  "，",
  "、",
  ";",
  "；",
  "(",
  "（",
  ")",
  "）",
  "[",
  "【",
  "]",
  "】",
  "{",
  "｛",
  "}",
  "｝",
  "'",
  '"',
  "“",
  "”",
  ":",
  "：",
  "+",
  "-",
  "*",
  "/",
  "=",
  "＝",
  "<",
  "《",
  ">",
  "》",
  "!",
  "！",
  "?",
  "？",
  "\\",
  "|",
  "&",
  "%",
  "^",
]);

const INDENT_OPEN = new Set([
  "如果",
  "如果真",
  "判断循环首",
  "计次循环首",
  "变量循环首",
  "循环判断首",
  "判断开始",
]);

const INDENT_CLOSE = new Set([
  "如果结束",
  "如果真结束",
  "判断循环尾",
  "计次循环尾",
  "变量循环尾",
  "循环判断尾",
  "判断结束",
]);

const INDENT_HALF = new Set(["否则", "默认"]);

function isEplPunctuationChar(ch: string): boolean {
  return EPL_PUNCTUATION.has(ch);
}

function isEplIdentifierChar(ch: string): boolean {
  return !/\s/.test(ch) && !isEplPunctuationChar(ch);
}

function normalizeEplKeyword(word: string): string {
  return word.startsWith(".") ? word.slice(1) : word;
}

function tokenize(line: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;

  const trimmedStart = line.match(/^(\s*)\./);
  if (trimmedStart) {
    const space = trimmedStart[1];
    if (space) out.push({ kind: "space", text: space });
    let j = space.length + 1;
    while (j < line.length && isEplIdentifierChar(line[j]) && line[j] !== ".") {
      j++;
    }
    const dottedWord = line.slice(space.length, j);
    const bareWord = normalizeEplKeyword(dottedWord);
    out.push({
      kind: EPL_KEYWORDS.has(bareWord) ? "keyword" : "directive",
      text: EPL_KEYWORDS.has(bareWord) ? bareWord : dottedWord,
    });
    i = j;
  }

  while (i < line.length) {
    const ch = line[i];

    if (ch === "'") {
      out.push({ kind: "comment", text: line.slice(i) });
      return out;
    }
    if (ch === "/" && line[i + 1] === "/") {
      out.push({ kind: "comment", text: line.slice(i) });
      return out;
    }

    if (ch === '"' || ch === "“" || ch === "”") {
      const closer = ch === "“" ? "”" : ch === "”" ? "”" : '"';
      let j = i + 1;
      while (j < line.length && line[j] !== closer) j++;
      const end = j < line.length ? j + 1 : j;
      out.push({ kind: "string", text: line.slice(i, end) });
      i = end;
      continue;
    }

    if (/\s/.test(ch)) {
      let j = i;
      while (j < line.length && /\s/.test(line[j])) j++;
      out.push({ kind: "space", text: line.slice(i, j) });
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < line.length && /[0-9.]/.test(line[j])) j++;
      out.push({ kind: "number", text: line.slice(i, j) });
      i = j;
      continue;
    }

    if (isEplPunctuationChar(ch)) {
      out.push({ kind: "punct", text: ch });
      i++;
      continue;
    }

    let j = i;
    while (j < line.length && isEplIdentifierChar(line[j])) j++;
    if (j === i) {
      out.push({ kind: "punct", text: ch });
      i++;
      continue;
    }
    const word = line.slice(i, j);
    let kind: TokenKind = "ident";
    if (EPL_KEYWORDS.has(word)) kind = "keyword";
    else if (EPL_TYPES.has(word)) kind = "type";
    else if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(word) && /[A-Z_]/.test(word)) {
      kind = "api";
    }
    out.push({ kind, text: word });
    i = j;
  }

  return out;
}

function renderTokens(tokens: Tok[]): React.ReactNode[] {
  return tokens.map((tok, idx) => {
    const nextNonSpace = tokens.slice(idx + 1).find((item) => item.kind !== "space");
    const isCallLike =
      (tok.kind === "api" || tok.kind === "ident") &&
      nextNonSpace?.kind === "punct" &&
      nextNonSpace.text === "(";
    const isConstLike = tok.kind === "ident" && tok.text.startsWith("#");

    switch (tok.kind) {
      case "directive":
        return (
          <span key={idx} className="epl-tok-directive">
            {tok.text}
          </span>
        );
      case "type":
        return (
          <span key={idx} className="eTypecolor inline-token">
            {tok.text}
          </span>
        );
      case "string":
        return (
          <span key={idx} className="Constanttext inline-token">
            {tok.text}
          </span>
        );
      case "number":
        return (
          <span key={idx} className="epl-tok-number inline-token">
            {tok.text}
          </span>
        );
      case "comment":
        return (
          <span key={idx} className="Remarkscolor inline-token">
            {tok.text}
          </span>
        );
      case "keyword":
        return (
          <span key={idx} className="comecolor inline-token">
            {tok.text}
          </span>
        );
      case "api":
        return (
          <span
            key={idx}
            className={cn(
              isCallLike ? "funccolor" : "eAPIcolor",
              "inline-token",
            )}
          >
            {tok.text}
          </span>
        );
      case "punct":
        return (
          <span key={idx} className="conscolor">
            {tok.text}
          </span>
        );
      case "ident":
        return (
          <span
            key={idx}
            className={cn(
              isConstLike
                ? "conscolor"
                : isCallLike
                  ? "funccolor"
                  : "Variablescolor",
              "inline-token",
            )}
          >
            {tok.text}
          </span>
        );
      case "space":
        return (
          <span key={idx}>{tok.text}</span>
        );
      default:
        return <span key={idx}>{tok.text}</span>;
    }
  });
}

// ---------------------------------------------------------------------------
// Block parser — groups lines into structured blocks
// ---------------------------------------------------------------------------

interface VarRow {
  name: string;
  typeName: string;
  isStatic: boolean;
  isPublic: boolean;
  isReference: boolean;
  isNullable: boolean;
  isArrayFlag: boolean;
  arraySize: string;
  value: string;
  remark: string;
}

type Block =
  | { type: "projectMeta"; lines: string[] }
  | { type: "header"; lines: string[] }
  | {
      type: "assembly";
      name: string;
      baseClass: string;
      isPublic: boolean;
      remark: string;
    }
  | {
      type: "sub";
      name: string;
      returnType: string;
      isPublic: boolean;
      remark: string;
      isDll: boolean;
    }
  | { type: "varTable"; kind: string; rows: VarRow[] }
  | { type: "code"; lines: string[] };

function splitDeclFields(line: string): string[] {
  const stripped = line.trim();
  const spaceIdx = stripped.indexOf(" ");
  if (spaceIdx < 0) return [];
  const rest = stripped.slice(spaceIdx + 1);
  return rest.split(/[,，]/).map((s) => s.trim());
}

function hasFlag(value: string | undefined, flag: string): boolean {
  if (!value) return false;
  return value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(flag);
}

function parseVarRow(kind: string, line: string): VarRow {
  const vf = splitDeclFields(line);
  const flags = vf[2] || "";

  if (kind === "参数") {
    return {
      name: vf[0] || "",
      typeName: vf[1] || "",
      isStatic: false,
      isPublic: false,
      isReference: hasFlag(flags, "参考"),
      isNullable: hasFlag(flags, "可空"),
      isArrayFlag: hasFlag(flags, "数组"),
      arraySize: "",
      value: "",
      remark: vf[3] || "",
    };
  }

  if (kind === "全局变量") {
    return {
      name: vf[0] || "",
      typeName: vf[1] || "",
      isStatic: false,
      isPublic: hasFlag(flags, "公开"),
      isReference: false,
      isNullable: false,
      isArrayFlag: false,
      arraySize: vf[3] || "",
      value: "",
      remark: vf[4] || "",
    };
  }

  if (kind === "常量") {
    return {
      name: vf[0] || "",
      typeName: "",
      isStatic: false,
      isPublic: hasFlag(vf[2], "公开"),
      isReference: false,
      isNullable: false,
      isArrayFlag: false,
      arraySize: "",
      value: vf[1] || "",
      remark: vf[3] || "",
    };
  }

  if (kind === "程序集变量") {
    return {
      name: vf[0] || "",
      typeName: vf[1] || "",
      isStatic: false,
      isPublic: false,
      isReference: false,
      isNullable: false,
      isArrayFlag: false,
      arraySize: vf[3] || "",
      value: "",
      remark: vf[4] || "",
    };
  }

  return {
    name: vf[0] || "",
    typeName: vf[1] || "",
    isStatic: hasFlag(flags, "静态"),
    isPublic: false,
    isReference: false,
    isNullable: false,
    isArrayFlag: false,
    arraySize: vf[3] || "",
    value: "",
    remark: vf[4] || "",
  };
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  function pushCode(line: string) {
    const last = blocks[blocks.length - 1];
    if (last && last.type === "code") {
      last.lines.push(line);
    } else {
      blocks.push({ type: "code", lines: [line] });
    }
  }

  function pushHeader(line: string) {
    const last = blocks[blocks.length - 1];
    if (last && last.type === "header") {
      last.lines.push(line);
    } else {
      blocks.push({ type: "header", lines: [line] });
    }
  }

  function pushProjectMeta(line: string) {
    const last = blocks[blocks.length - 1];
    if (last && last.type === "projectMeta") {
      last.lines.push(line);
    } else {
      blocks.push({ type: "projectMeta", lines: [line] });
    }
  }

  while (i < lines.length) {
    const raw = lines[i];
    const stripped = raw.trim();

    if (!stripped) {
      pushCode(raw);
      i++;
      continue;
    }

    // Project metadata exists in copied/exported text, but 易语言 IDE keeps it
    // outside the visual code editor. D:\e's ExuiTool does the same kind of
    // lineCodes -> display lineCodesR split for .版本 and .支持库.
    if (
      stripped.startsWith(".版本") ||
      stripped.startsWith(".支持库") ||
      stripped.startsWith(".模块")
    ) {
      pushProjectMeta(raw);
      i++;
      continue;
    }

    // Assembly line: .程序集
    if (stripped === ".程序集" || stripped.startsWith(".程序集 ")) {
      const fields = splitDeclFields(raw);
      if (fields.length > 0) {
        blocks.push({
          type: "assembly",
          name: fields[0] || "",
          baseClass: fields[1] || "",
          isPublic: hasFlag(fields[2], "公开"),
          remark: fields[3] || "",
        });
      } else {
        pushCode(raw);
      }
      i++;
      continue;
    }

    // Assembly variables: .程序集变量
    if (stripped.startsWith(".程序集变量")) {
      const rows: VarRow[] = [];
      while (i < lines.length) {
        const nextRaw = lines[i];
        const nextStripped = nextRaw.trim();
        if (!nextStripped.startsWith(".程序集变量")) break;
        rows.push(parseVarRow("程序集变量", nextRaw));
        i++;
      }
      if (rows.length > 0) {
        blocks.push({ type: "varTable", kind: "程序集变量", rows });
      }
      continue;
    }

    // Sub-routine: .子程序 / .DLL命令
    if (stripped.startsWith(".子程序") || stripped.startsWith(".DLL命令")) {
      const isDll = stripped.startsWith(".DLL命令");
      const fields = splitDeclFields(raw);
      const name = fields[0] || "";
      const returnType = fields[1] || "";
      const pubFlag = isDll ? fields[4] : fields[2];
      const remark = (isDll ? fields[5] : fields[3]) || "";
      const isPublic = hasFlag(pubFlag, "公开");
      blocks.push({
        type: "sub",
        name,
        returnType,
        isPublic,
        remark,
        isDll,
      });

      // Collect following .参数 / .局部变量 lines into varTable blocks
      i++;
      let currentVarKind: string | null = null;
      let currentRows: VarRow[] = [];

      while (i < lines.length) {
        const nextRaw = lines[i];
        const nextStripped = nextRaw.trim();

        let varKind: string | null = null;
        if (nextStripped.startsWith(".局部变量")) varKind = "局部变量";
        else if (nextStripped.startsWith(".参数")) varKind = "参数";
        else if (nextStripped.startsWith(".全局变量")) varKind = "全局变量";
        else if (nextStripped.startsWith(".常量")) varKind = "常量";
        else if (nextStripped.startsWith(".程序集变量")) varKind = "程序集变量";

        if (varKind) {
          if (currentVarKind && currentVarKind !== varKind) {
            blocks.push({ type: "varTable", kind: currentVarKind, rows: currentRows });
            currentRows = [];
          }
          currentVarKind = varKind;

          currentRows.push(parseVarRow(varKind, nextRaw));
          i++;
        } else {
          break;
        }
      }

      if (currentVarKind && currentRows.length > 0) {
        blocks.push({ type: "varTable", kind: currentVarKind, rows: currentRows });
      }
      continue;
    }

    // Standalone variable declarations (outside a .子程序 context)
    if (
      stripped.startsWith(".局部变量") ||
      stripped.startsWith(".参数") ||
      stripped.startsWith(".全局变量") ||
      stripped.startsWith(".常量")
    ) {
      let varKind = "";
      if (stripped.startsWith(".局部变量")) varKind = "局部变量";
      else if (stripped.startsWith(".参数")) varKind = "参数";
      else if (stripped.startsWith(".全局变量")) varKind = "全局变量";
      else if (stripped.startsWith(".常量")) varKind = "常量";

      const rows: VarRow[] = [];
      while (i < lines.length) {
        const nextRaw = lines[i];
        const nextStripped = nextRaw.trim();
        let nk: string | null = null;
        if (nextStripped.startsWith(".局部变量")) nk = "局部变量";
        else if (nextStripped.startsWith(".参数")) nk = "参数";
        else if (nextStripped.startsWith(".全局变量")) nk = "全局变量";
        else if (nextStripped.startsWith(".常量")) nk = "常量";
        else if (nextStripped.startsWith(".程序集变量")) nk = "程序集变量";

        if (nk === varKind) {
          rows.push(parseVarRow(varKind, nextRaw));
          i++;
        } else {
          break;
        }
      }

      if (rows.length > 0) {
        blocks.push({ type: "varTable", kind: varKind, rows });
      }
      continue;
    }

    // Data types
    if (stripped.startsWith(".数据类型")) {
      pushHeader(raw);
      i++;
      continue;
    }

    // Regular code / remark
    pushCode(raw);
    i++;
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Code tree parser / renderer
// ---------------------------------------------------------------------------

function getFirstKeyword(line: string): string | null {
  const stripped = line.trim().replace(/^\./, "");
  if (!stripped || stripped.startsWith("'") || stripped.startsWith("//")) return null;

  let end = 0;
  while (
    end < stripped.length &&
    stripped[end] !== "." &&
    isEplIdentifierChar(stripped[end])
  ) {
    end++;
  }

  const word = stripped.slice(0, end);
  return word ? normalizeEplKeyword(word) : null;
}

type ControlBlockKind =
  | "if"
  | "ifTrue"
  | "judge"
  | "judgeLoop"
  | "varLoop"
  | "countLoop"
  | "loopJudge";

interface ControlLineInfo {
  kind: ControlBlockKind;
  role: "start" | "branch" | "end";
  visible: boolean;
  labelOverride?: string;
}

interface CodeSourceLine {
  sourceIndex: number;
  rawLine: string;
  displayLine: string;
  keyword: string | null;
  isBlank: boolean;
  isRemark: boolean;
  control: ControlLineInfo | null;
}

interface CodeTextNode {
  type: "line";
  line: CodeSourceLine;
}

interface CodeBlockSection {
  marker: CodeSourceLine | null;
  items: CodeNode[];
}

interface CodeBlockNode {
  type: "block";
  kind: ControlBlockKind;
  start: CodeSourceLine;
  items: CodeNode[];
  end: CodeSourceLine | null;
}

type CodeNode = CodeTextNode | CodeBlockNode;

function classifyControlLine(keyword: string | null): ControlLineInfo | null {
  if (!keyword) return null;

  switch (keyword) {
    case "如果":
      return { kind: "if", role: "start", visible: true };
    case "如果真":
      return { kind: "ifTrue", role: "start", visible: true };
    case "如果结束":
      return { kind: "if", role: "end", visible: false };
    case "如果真结束":
      return { kind: "ifTrue", role: "end", visible: false };
    case "判断开始":
      return { kind: "judge", role: "start", visible: true, labelOverride: "判断" };
    case "判断":
      return { kind: "judge", role: "branch", visible: true };
    case "默认":
      return { kind: "judge", role: "branch", visible: false };
    case "判断结束":
      return { kind: "judge", role: "end", visible: false };
    case "判断循环首":
      return { kind: "judgeLoop", role: "start", visible: true };
    case "计次循环首":
      return { kind: "countLoop", role: "start", visible: true };
    case "变量循环首":
      return { kind: "varLoop", role: "start", visible: true };
    case "循环判断首":
      return { kind: "loopJudge", role: "start", visible: true };
    case "判断循环尾":
      return { kind: "judgeLoop", role: "end", visible: true };
    case "计次循环尾":
      return { kind: "countLoop", role: "end", visible: true };
    case "变量循环尾":
      return { kind: "varLoop", role: "end", visible: true };
    case "循环判断尾":
      return { kind: "loopJudge", role: "end", visible: true };
    case "否则":
      return { kind: "if", role: "branch", visible: false };
    default:
      return null;
  }
}

function normalizeCodeLine(rawLine: string): string {
  return rawLine.replace(/^[\t\u3000 ]+/, "");
}

function buildCodeSourceLines(lines: string[]): CodeSourceLine[] {
  return lines.map((rawLine, sourceIndex) => {
    const displayLine = normalizeCodeLine(rawLine);
    const keyword = getFirstKeyword(displayLine);
    const control = classifyControlLine(keyword);
    const stripped = displayLine.trim();

    return {
      sourceIndex,
      rawLine,
      displayLine,
      keyword,
      isBlank: stripped.length === 0,
      isRemark: stripped.startsWith("'") || stripped.startsWith("//"),
      control,
    };
  });
}

function supportsBranching(kind: ControlBlockKind): boolean {
  return kind === "if" || kind === "judge";
}

function buildCodeTree(lines: string[]): CodeNode[] {
  const sourceLines = buildCodeSourceLines(lines);
  const rootItems: CodeNode[] = [];
  const stack: Array<
    | { kind: "root"; items: CodeNode[] }
    | { kind: "block"; block: CodeBlockNode; items: CodeNode[] }
  > = [{ kind: "root", items: rootItems }];

  function currentItems(): CodeNode[] {
    return stack[stack.length - 1].items;
  }

  function appendLine(line: CodeSourceLine) {
    currentItems().push({ type: "line", line });
  }

  function findOpenBlockIndex(kind: ControlBlockKind): number {
    for (let i = stack.length - 1; i >= 0; i--) {
      const frame = stack[i];
      if (frame.kind === "block" && frame.block.kind === kind) {
        return i;
      }
    }
    return -1;
  }

  for (const line of sourceLines) {
    const control = line.control;
    if (!control) {
      appendLine(line);
      continue;
    }

    if (control.role === "start") {
      const block: CodeBlockNode = {
        type: "block",
        kind: control.kind,
        start: line,
        items: [],
        end: null,
      };
      currentItems().push(block);
      stack.push({ kind: "block", block, items: block.items });
      continue;
    }

    if (control.role === "branch") {
      appendLine(line);
      continue;
    }

    if (control.role === "end") {
      const blockIndex = findOpenBlockIndex(control.kind);
      if (blockIndex < 0) {
        appendLine(line);
        continue;
      }

      while (stack.length > blockIndex + 1) {
        stack.pop();
      }

      const blockFrame = stack[blockIndex];
      if (blockFrame.kind !== "block") {
        appendLine(line);
        continue;
      }

      blockFrame.block.end = line;
      stack.pop();
      continue;
    }
  }

  return rootItems;
}

function getRenderableCodeLine(line: CodeSourceLine): string {
  if (line.control?.kind === "judge" && line.control.role === "start" && line.control.labelOverride) {
    return line.displayLine.replace(/^(\s*)\.?判断开始/, "$1.判断");
  }
  return line.displayLine;
}

function getControlLabelClass(line: CodeSourceLine): string {
  const control = line.control;
  if (!control) return "";

  if (control.role === "start") {
    switch (control.kind) {
      case "if":
        return "sysCommand if";
      case "ifTrue":
        return "sysCommand ifTrue";
      case "judge":
        return "sysCommand judge";
      default:
        return "sysCommand cycle";
    }
  }

  if (control.role === "branch") {
    if (control.kind === "judge") {
      return control.visible ? "sysCommand judgeChild" : "sysCommand judgeDef def";
    }
    return "sysCommand ifDef def";
  }

  switch (control.kind) {
    case "if":
      return "sysCommand ifClose close";
    case "ifTrue":
      return "sysCommand close ifTrueClose";
    case "judge":
      return "sysCommand close judgeClose";
    default:
      return "sysCommand";
  }
}

function renderControlLabel(line: CodeSourceLine): React.ReactNode {
  const control = line.control;
  if (!control) return renderTokens(tokenize(line.displayLine));

  if (control.role === "branch" && control.visible && control.kind === "judge") {
    const content = renderTokens(tokenize(getRenderableCodeLine(line)));
    return (
      <span className="sysCommand judgeChild">
        <span className="line1">
          <i className="triangle-right" />
          <i className="triangle-down" />
          <span className="line3" />
        </span>
        <span className="line2">
          <i className="triangle-down" />
          <i className="triangle-right" />
          <span className="line4" />
        </span>
        {content}
      </span>
    );
  }

  return (
    <span className={getControlLabelClass(line)}>
      {renderTokens(tokenize(getRenderableCodeLine(line)))}
    </span>
  );
}

function renderIdeLines(): React.ReactNode {
  return (
    <>
      <span className="line1" aria-hidden="true">
        <i className="triangle-right" />
        <i className="triangle-down" />
        <span className="line3" />
      </span>
      <span className="line2" aria-hidden="true">
        <i className="triangle-down" />
        <i className="triangle-right" />
        <span className="line4" />
      </span>
    </>
  );
}

function renderCodeParagraph(
  line: CodeSourceLine,
  showLineNumbers: boolean,
  nextLineNo: () => number,
  className?: string,
): React.ReactElement {
  const control = line.control;
  const content =
    line.isBlank && !control
      ? "\u00a0"
      : control
        ? renderControlLabel(line)
        : renderTokens(tokenize(getRenderableCodeLine(line)));

  return (
    <p
      key={line.sourceIndex}
      className={cn(
        "epl-ide-line",
        "codeline",
        className,
        line.isRemark && "is-remark",
        line.isBlank && "is-blank",
        control && "is-control-line",
        control?.role === "end" && !control.visible && "is-hidden-close-line",
        control?.role === "branch" && !control.visible && "is-hidden-branch-line",
      )}
      data-line-no={showLineNumbers ? nextLineNo() : undefined}
    >
      {content}
    </p>
  );
}

function getBlockClass(kind: ControlBlockKind): string {
  switch (kind) {
    case "if":
      return "epl-ide-if";
    case "ifTrue":
      return "epl-ide-if-true";
    case "judge":
      return "epl-ide-judge";
    default:
      return "epl-ide-cycle";
  }
}

function renderCodeNodes(
  nodes: CodeNode[],
  showLineNumbers: boolean,
  nextLineNo: () => number,
): React.ReactNode[] {
  return nodes.map((node) => {
    if (node.type === "line") {
      return renderCodeParagraph(node.line, showLineNumbers, nextLineNo);
    }

    const block = node;
    return (
      <ul
        key={block.start.sourceIndex}
        className={cn("epl-ide-block", getBlockClass(block.kind))}
        data-block-kind={block.kind}
      >
        {renderIdeLines()}
        {renderCodeParagraph(block.start, showLineNumbers, nextLineNo, "epl-ide-start-line")}
        {block.items.map((item) => (
          <li key={item.type === "line" ? item.line.sourceIndex : item.start.sourceIndex}>
            {renderCodeNodes([item], showLineNumbers, nextLineNo)}
          </li>
        ))}
        {block.end && renderCodeParagraph(block.end, showLineNumbers, nextLineNo, "epl-ide-end-line")}
      </ul>
    );
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function joinClassNames(...items: Array<string | false | null | undefined>): string {
  return items.filter(Boolean).join(" ");
}

function renderTokensHtml(tokens: Tok[]): string {
  return tokens.map((tok, idx) => {
    const nextNonSpace = tokens.slice(idx + 1).find((item) => item.kind !== "space");
    const isCallLike =
      (tok.kind === "api" || tok.kind === "ident") &&
      nextNonSpace?.kind === "punct" &&
      nextNonSpace.text === "(";
    const isConstLike = tok.kind === "ident" && tok.text.startsWith("#");
    const text = escapeHtml(tok.text);

    switch (tok.kind) {
      case "directive":
        return `<span class="epl-tok-directive">${text}</span>`;
      case "type":
        return `<span class="eTypecolor inline-token">${text}</span>`;
      case "string":
        return `<span class="Constanttext inline-token">${text}</span>`;
      case "number":
        return `<span class="epl-tok-number inline-token">${text}</span>`;
      case "comment":
        return `<span class="Remarkscolor inline-token">${text}</span>`;
      case "keyword":
        return `<span class="comecolor inline-token">${text}</span>`;
      case "api":
        return `<span class="${joinClassNames(isCallLike ? "funccolor" : "eAPIcolor", "inline-token")}">${text}</span>`;
      case "punct":
        return `<span class="conscolor">${text}</span>`;
      case "ident":
        return `<span class="${joinClassNames(
          isConstLike
            ? "conscolor"
            : isCallLike
              ? "funccolor"
              : "Variablescolor",
          "inline-token",
        )}">${text}</span>`;
      case "space":
        return `<span>${text}</span>`;
      default:
        return `<span>${text}</span>`;
    }
  }).join("");
}

function renderIdeLinesHtml(): string {
  return [
    `<span class="line1" aria-hidden="true"><i class="triangle-right"></i><i class="triangle-down"></i><span class="line3"></span></span>`,
    `<span class="line2" aria-hidden="true"><i class="triangle-down"></i><i class="triangle-right"></i><span class="line4"></span></span>`,
  ].join("");
}

function renderControlLabelHtml(line: CodeSourceLine): string {
  const control = line.control;
  if (!control) return renderTokensHtml(tokenize(line.displayLine));

  if (control.role === "branch" && control.visible && control.kind === "judge") {
    const content = renderTokensHtml(tokenize(getRenderableCodeLine(line)));
    return `<span class="sysCommand judgeChild">${renderIdeLinesHtml()}${content}</span>`;
  }

  return `<span class="${getControlLabelClass(line)}">${renderTokensHtml(tokenize(getRenderableCodeLine(line)))}</span>`;
}

function renderCodeParagraphHtml(
  line: CodeSourceLine,
  showLineNumbers: boolean,
  nextLineNo: () => number,
  className?: string,
): string {
  const control = line.control;
  const content =
    line.isBlank && !control
      ? "&nbsp;"
      : control
        ? renderControlLabelHtml(line)
        : renderTokensHtml(tokenize(getRenderableCodeLine(line)));
  const lineNo = showLineNumbers ? ` data-line-no="${nextLineNo()}"` : "";
  const classes = joinClassNames(
    "epl-ide-line",
    "codeline",
    className,
    line.isRemark && "is-remark",
    line.isBlank && "is-blank",
    control && "is-control-line",
    control?.role === "end" && !control.visible && "is-hidden-close-line",
    control?.role === "branch" && !control.visible && "is-hidden-branch-line",
  );
  return `<p class="${classes}"${lineNo}>${content}</p>`;
}

function renderCodeNodesHtml(
  nodes: CodeNode[],
  showLineNumbers: boolean,
  nextLineNo: () => number,
): string {
  return nodes.map((node) => {
    if (node.type === "line") {
      return renderCodeParagraphHtml(node.line, showLineNumbers, nextLineNo);
    }

    const block = node;
    const items = block.items.map((item) => {
      const key = item.type === "line" ? item.line.sourceIndex : item.start.sourceIndex;
      return `<li data-key="${key}">${renderCodeNodesHtml([item], showLineNumbers, nextLineNo)}</li>`;
    }).join("");
    const end = block.end
      ? renderCodeParagraphHtml(block.end, showLineNumbers, nextLineNo, "epl-ide-end-line")
      : "";
    return `<ul class="${joinClassNames("epl-ide-block", getBlockClass(block.kind))}" data-block-kind="${block.kind}">${renderIdeLinesHtml()}${renderCodeParagraphHtml(block.start, showLineNumbers, nextLineNo, "epl-ide-start-line")}${items}${end}</ul>`;
  }).join("");
}

function renderPlainRowHtml(
  showLineNumbers: boolean,
  no: number,
  rowClass: string,
  bodyClassName: string | undefined,
  content: string,
): string {
  return [
    `<div class="${joinClassNames("epl-code-row", rowClass, "Rowheight")}">`,
    showLineNumbers ? `<div class="epl-row-no">${no}</div>` : "",
    `<div class="${joinClassNames("epl-row-body", bodyClassName)}"><span class="epl-row-content">${content}</span></div>`,
    `</div>`,
  ].join("");
}

function renderCheckCell(checked: boolean): string {
  return `<td class="${joinClassNames("gou", checked && "is-checked")}">${checked ? "√" : ""}</td>`;
}

function renderVarRowsHtml(rows: VarRow[], cellsForRow: (row: VarRow) => string, nextLineNo: () => number): string {
  return `<tbody>${rows.map((row) => {
    nextLineNo();
    return `<tr>${cellsForRow(row)}</tr>`;
  }).join("")}</tbody>`;
}

export function renderEplToHtml(
  code: string,
  options: {
    theme?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
    showLineNumbers?: boolean;
    className?: string;
  } = {},
): string {
  const theme = options.theme ?? 1;
  const showLineNumbers = options.showLineNumbers ?? true;
  const blocks = parseBlocks(code.replace(/\r\n?/g, "\n").split("\n"));
  let lineNo = 0;
  const nextLineNo = () => {
    lineNo += 1;
    return lineNo;
  };

  const body = blocks.map((block, bIdx) => {
    switch (block.type) {
      case "projectMeta":
        return "";

      case "header":
        return `<div class="epl-code-block">${block.lines.map((line) => {
          const no = nextLineNo();
          return renderPlainRowHtml(
            showLineNumbers,
            no,
            "epl-row-header",
            "eHeadercolor",
            renderTokensHtml(tokenize(line)),
          );
        }).join("")}</div>`;

      case "assembly":
        nextLineNo();
        return `<table class="variable epl-assembly-table" cellpadding="0" cellspacing="0"><thead><tr class="eAssemblyheadcolor"><th>类名</th><th>基 类</th><th class="center width_35">公开</th><th>备 注</th></tr></thead><tbody><tr><td class="eProcolor epl-sub-name">${escapeHtml(block.name)}</td><td class="type">${escapeHtml(block.baseClass)}</td>${renderCheckCell(block.isPublic)}<td class="beizhu">${escapeHtml(block.remark)}</td></tr></tbody></table>`;

      case "sub": {
        nextLineNo();
        const label = block.isDll ? "DLL命令名" : "子程序名";
        return `<table class="variable" cellpadding="0" cellspacing="0"><thead><tr class="eHeadercolor"><th>${label}</th><th>返回值类型</th><th class="center width_35">公开</th><th class="center width_35">易包</th><th>备注</th></tr></thead><tbody><tr><td class="eProcolor epl-sub-name">${escapeHtml(block.name)}</td><td class="type">${escapeHtml(block.returnType)}</td>${renderCheckCell(block.isPublic)}<td class="epl-empty-cell"></td><td class="beizhu">${escapeHtml(block.remark)}</td></tr></tbody></table>`;
      }

      case "varTable":
        if (block.kind === "参数") {
          return `<table class="variable" cellpadding="0" cellspacing="0"><thead><tr class="eHeadercolor"><th>参数名</th><th>类 型</th><th class="center width_35">参考</th><th class="center width_35">可空</th><th class="center width_35">数组</th><th>备 注</th></tr></thead>${renderVarRowsHtml(block.rows, (row) => `<td class="Variablescolor">${escapeHtml(row.name)}</td><td class="type">${escapeHtml(row.typeName)}</td>${renderCheckCell(row.isReference)}${renderCheckCell(row.isNullable)}${renderCheckCell(row.isArrayFlag)}<td class="beizhu">${escapeHtml(row.remark)}</td>`, nextLineNo)}</table>`;
        }
        if (block.kind === "程序集变量") {
          return `<table class="variable" cellpadding="0" cellspacing="0"><thead><tr class="eAssemblyheadcolor"><th>变量名</th><th>类 型</th><th class="center width_35">数组</th><th>备 注</th></tr></thead>${renderVarRowsHtml(block.rows, (row) => `<td class="Variablescolor">${escapeHtml(row.name)}</td><td class="type">${escapeHtml(row.typeName)}</td><td class="eArraycolor epl-array-cell">${row.arraySize && row.arraySize !== "0" ? escapeHtml(row.arraySize) : ""}</td><td class="beizhu">${escapeHtml(row.remark)}</td>`, nextLineNo)}</table>`;
        }
        if (block.kind === "全局变量") {
          return `<table class="variable" cellpadding="0" cellspacing="0"><thead><tr class="eVariableheadcolor"><th>全局变量名</th><th>类型</th><th class="center width_35">数组</th><th class="center width_35">公开</th><th>备注</th></tr></thead>${renderVarRowsHtml(block.rows, (row) => `<td class="Variablescolor">${escapeHtml(row.name)}</td><td class="type">${escapeHtml(row.typeName)}</td><td class="eArraycolor epl-array-cell">${row.arraySize && row.arraySize !== "0" ? escapeHtml(row.arraySize) : ""}</td>${renderCheckCell(row.isPublic)}<td class="beizhu">${escapeHtml(row.remark)}</td>`, nextLineNo)}</table>`;
        }
        if (block.kind === "常量") {
          return `<table class="variable" cellpadding="0" cellspacing="0"><thead><tr class="eHeadercolor"><th>常量名称</th><th>常量值</th><th class="center width_35">公开</th><th>备 注</th></tr></thead>${renderVarRowsHtml(block.rows, (row) => `<td class="Variablescolor">${escapeHtml(row.name)}</td><td class="conscolor">${escapeHtml(row.value)}</td>${renderCheckCell(row.isPublic)}<td class="beizhu">${escapeHtml(row.remark)}</td>`, nextLineNo)}</table>`;
        }
        return `<table class="variable" cellpadding="0" cellspacing="0"><thead><tr class="eVariableheadcolor"><th>变量名</th><th>类 型</th><th class="center width_35">静态</th><th class="center width_35">数组</th><th>备注</th></tr></thead><tbody>${block.rows.map((row) => {
          nextLineNo();
          return `<tr><td class="Variablescolor">${escapeHtml(row.name)}</td><td class="type">${escapeHtml(row.typeName)}</td>${renderCheckCell(row.isStatic)}<td class="eArraycolor epl-array-cell">${row.arraySize && row.arraySize !== "0" ? escapeHtml(row.arraySize) : ""}</td><td class="beizhu">${escapeHtml(row.remark)}</td></tr>`;
        }).join("")}</tbody></table>`;

      case "code":
        return `<div class="epl-source-stream">${renderCodeNodesHtml(buildCodeTree(block.lines), showLineNumbers, nextLineNo)}</div>`;

      default:
        return "";
    }
  }).join("");

  return `<div class="${joinClassNames(
    "epl-renderer",
    `ebackcolor${theme}`,
    showLineNumbers ? "epl-with-line-numbers" : "epl-no-line-numbers",
    options.className,
  )}" data-mobile-epl="${Date.now()}">${body}</div>`;
}

function resetIdeLine(el: HTMLElement | null) {
  if (!el) return;
  el.removeAttribute("style");
  el.querySelectorAll<HTMLElement>(".triangle-right, .triangle-down, .line3, .line4").forEach((child) => {
    child.removeAttribute("style");
  });
}

function showArrow(parent: HTMLElement | null, selector: ".triangle-right" | ".triangle-down") {
  const arrow = parent?.querySelector<HTMLElement>(selector);
  if (arrow) arrow.style.display = "block";
}

function getDirectLine(ul: HTMLElement, selector: ".line1" | ".line2"): HTMLElement | null {
  for (const child of Array.from(ul.children)) {
    if (child instanceof HTMLElement && child.classList.contains(selector.slice(1))) {
      return child;
    }
  }
  return null;
}

function directParagraph(element: HTMLElement | null): HTMLElement | null {
  if (!element) return null;
  if (element.tagName === "P") return element;
  for (const child of Array.from(element.children)) {
    if (child instanceof HTMLElement && child.tagName === "P") return child;
  }
  return null;
}

function directCommand(element: HTMLElement | null, selector = ".sysCommand"): HTMLElement | null {
  const p = directParagraph(element);
  if (!p) return null;
  for (const child of Array.from(p.children)) {
    if (child instanceof HTMLElement && child.matches(selector)) {
      return child;
    }
  }
  return null;
}

function isDirectCommand(element: HTMLElement | null, selector: string): boolean {
  return Boolean(directCommand(element, selector));
}

function applyIdeFlowLayout(root: HTMLElement) {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("ul.epl-ide-block"));

  blocks.forEach((block) => {
    resetIdeLine(getDirectLine(block, ".line1"));
    resetIdeLine(getDirectLine(block, ".line2"));
    block.querySelectorAll<HTMLElement>(".judgeChild .line1, .judgeChild .line2").forEach(resetIdeLine);
  });

  blocks.forEach((block) => {
    const children = Array.from(block.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
    const line1 = getDirectLine(block, ".line1");
    const line2 = getDirectLine(block, ".line2");
    const firstCode = children[2];
    const close = children[children.length - 1];
    if (!line1 || !line2 || !firstCode || !close) return;

    const isCycle = block.classList.contains("epl-ide-cycle");
    const isIfTrue = block.classList.contains("epl-ide-if-true");
    const isIf = block.classList.contains("epl-ide-if");
    const isJudge = block.classList.contains("epl-ide-judge");
    const directItems = children.slice(3, -1);
    const defItem = directItems.find((item) => isDirectCommand(item, ".def")) ?? null;
    const judgeChildren = directItems.filter((item) => isDirectCommand(item, ".judgeChild"));

    if (isCycle) {
      line1.style.top = "10px";
      line1.style.height = `${Math.max(0, block.clientHeight - 20)}px`;
      showArrow(line1, ".triangle-right");
      const arrow = line1.querySelector<HTMLElement>(".triangle-right");
      if (arrow) arrow.style.top = "-5px";
      return;
    }

    if (isIfTrue) {
      line1.style.display = "none";
      line2.style.display = "block";
      line2.style.left = "2px";
      line2.style.width = "15px";
      line2.style.top = "10px";
      line2.style.height = `${Math.max(0, close.offsetTop + close.offsetHeight - 10)}px`;
      showArrow(line2, ".triangle-down");
      return;
    }

    if (isIf) {
      line1.style.top = "10px";
      line1.style.height = `${Math.max(0, (defItem ?? close).offsetTop)}px`;
      showArrow(line1, ".triangle-right");
      const right = line1.querySelector<HTMLElement>(".triangle-right");
      if (right) right.style.bottom = "-5px";

      line2.style.display = "block";
      line2.style.top = `${Math.max(0, (defItem ?? close).offsetTop - 10)}px`;
      line2.style.height = `${Math.max(0, close.offsetTop - (defItem ?? close).offsetTop + close.offsetHeight + 10)}px`;
      showArrow(line2, ".triangle-down");
      return;
    }

    if (isJudge) {
      const fallbackDef = defItem ?? close;
      line1.style.top = "10px";
      line1.style.height = `${Math.max(0, (judgeChildren[0] ?? fallbackDef).offsetTop)}px`;
      showArrow(line1, ".triangle-right");
      const right = line1.querySelector<HTMLElement>(".triangle-right");
      if (right) right.style.bottom = "-5px";

      if (judgeChildren.length || defItem) {
        line2.style.display = "block";
        const topItem = judgeChildren[0] ?? fallbackDef;
        line2.style.top = `${Math.max(0, topItem.offsetTop - 10)}px`;
        line2.style.height = `${Math.max(0, close.offsetTop - topItem.offsetTop + close.offsetHeight + 10)}px`;
        showArrow(line2, ".triangle-down");
      }

      judgeChildren.forEach((item, index) => {
        const marker = directCommand(item, ".judgeChild");
        const branchLine1 = marker?.querySelector<HTMLElement>(".line1") ?? null;
        const branchLine2 = marker?.querySelector<HTMLElement>(".line2") ?? null;
        if (!branchLine1 || !branchLine2) return;
        const next = judgeChildren[index + 1] ?? defItem ?? close;
        branchLine1.style.display = "block";
        branchLine1.style.left = "-20px";
        branchLine1.style.top = "14px";
        branchLine1.style.height = `${Math.max(8, next.offsetTop - item.offsetTop - 10)}px`;
        showArrow(branchLine1, ".triangle-right");
        const branchRight = branchLine1.querySelector<HTMLElement>(".triangle-right");
        if (branchRight) branchRight.style.bottom = "-5px";
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface EplRendererProps {
  code: string;
  theme?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  showLineNumbers?: boolean;
  className?: string;
}

export function EplRenderer({
  code,
  theme = 1,
  showLineNumbers = true,
  className,
}: EplRendererProps) {
  const rendererRef = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => {
    const lines = code.replace(/\r\n?/g, "\n").split("\n");
    return parseBlocks(lines);
  }, [code]);

  useLayoutEffect(() => {
    if (rendererRef.current) {
      applyIdeFlowLayout(rendererRef.current);
    }
  }, [blocks, showLineNumbers]);

  let lineNo = 0;

  function nextLineNo() {
    lineNo++;
    return lineNo;
  }

  function renderPlainRow(
    key: React.Key,
    no: number,
    rowClass: string,
    bodyClassName: string | undefined,
    content: React.ReactNode,
    contentStyle?: React.CSSProperties,
  ) {
    return (
      <div key={key} className={cn("epl-code-row", rowClass, "Rowheight")}>
        {showLineNumbers && <div className="epl-row-no">{no}</div>}
        <div className={cn("epl-row-body", bodyClassName)}>
          <span className="epl-row-content" style={contentStyle}>
            {content}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rendererRef}
      className={cn(
        "epl-renderer ebackcolor" + theme,
        showLineNumbers ? "epl-with-line-numbers" : "epl-no-line-numbers",
        className,
      )}
    >
      {blocks.map((block, bIdx) => {
        switch (block.type) {
          case "projectMeta":
            return null;

          case "header":
            return (
              <div key={bIdx} className="epl-code-block">
                {block.lines.map((line, li) => {
                  const no = nextLineNo();
                  const tokens = tokenize(line);
                  return renderPlainRow(
                    li,
                    no,
                    "epl-row-header",
                    "eHeadercolor",
                    renderTokens(tokens),
                  );
                })}
              </div>
            );

          case "assembly": {
            nextLineNo(); // count this declaration line
            return (
              <table key={bIdx} className="variable epl-assembly-table" cellPadding={0} cellSpacing={0}>
                <thead>
                  <tr className="eAssemblyheadcolor">
                    <th>类名</th>
                    <th>基 类</th>
                    <th className="center width_35">公开</th>
                    <th>备 注</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="eProcolor epl-sub-name">{block.name}</td>
                    <td className="type">{block.baseClass}</td>
                    <td className={cn("gou", block.isPublic && "is-checked")}>
                      {block.isPublic ? "√" : ""}
                    </td>
                    <td className="beizhu">{block.remark}</td>
                  </tr>
                </tbody>
              </table>
            );
          }

          case "sub": {
            nextLineNo(); // count this declaration line
            const label = block.isDll ? "DLL命令名" : "子程序名";
            return (
              <table key={bIdx} className="variable" cellPadding={0} cellSpacing={0}>
                <thead>
                  <tr className="eHeadercolor">
                    <th>{label}</th>
                    <th>返回值类型</th>
                    <th className="center width_35">公开</th>
                    <th className="center width_35">易包</th>
                    <th>备注</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="eProcolor epl-sub-name">{block.name}</td>
                    <td className="type">{block.returnType}</td>
                    <td className={cn("gou", block.isPublic && "is-checked")}>
                      {block.isPublic ? "√" : ""}
                    </td>
                    <td className="epl-empty-cell"></td>
                    <td className="beizhu">{block.remark}</td>
                  </tr>
                </tbody>
              </table>
            );
          }

          case "varTable": {
            const renderRows = (
              cellsForRow: (row: VarRow) => React.ReactNode,
            ) => (
              <tbody>
                {block.rows.map((row, ri) => {
                  nextLineNo();
                  return <tr key={ri}>{cellsForRow(row)}</tr>;
                })}
              </tbody>
            );

            if (block.kind === "参数") {
              return (
                <table key={bIdx} className="variable" cellPadding={0} cellSpacing={0}>
                  <thead>
                    <tr className="eHeadercolor">
                      <th>参数名</th>
                      <th>类 型</th>
                      <th className="center width_35">参考</th>
                      <th className="center width_35">可空</th>
                      <th className="center width_35">数组</th>
                      <th>备 注</th>
                    </tr>
                  </thead>
                  {renderRows((row) => (
                    <>
                      <td className="Variablescolor">{row.name}</td>
                      <td className="type">{row.typeName}</td>
                      <td className={cn("gou", row.isReference && "is-checked")}>
                        {row.isReference ? "√" : ""}
                      </td>
                      <td className={cn("gou", row.isNullable && "is-checked")}>
                        {row.isNullable ? "√" : ""}
                      </td>
                      <td className={cn("gou", row.isArrayFlag && "is-checked")}>
                        {row.isArrayFlag ? "√" : ""}
                      </td>
                      <td className="beizhu">{row.remark}</td>
                    </>
                  ))}
                </table>
              );
            }

            if (block.kind === "程序集变量") {
              return (
                <table key={bIdx} className="variable" cellPadding={0} cellSpacing={0}>
                  <thead>
                    <tr className="eAssemblyheadcolor">
                      <th>变量名</th>
                      <th>类 型</th>
                      <th className="center width_35">数组</th>
                      <th>备 注</th>
                    </tr>
                  </thead>
                  {renderRows((row) => (
                    <>
                      <td className="Variablescolor">{row.name}</td>
                      <td className="type">{row.typeName}</td>
                      <td className="eArraycolor epl-array-cell">
                        {row.arraySize && row.arraySize !== "0" ? row.arraySize : ""}
                      </td>
                      <td className="beizhu">{row.remark}</td>
                    </>
                  ))}
                </table>
              );
            }

            if (block.kind === "全局变量") {
              return (
                <table key={bIdx} className="variable" cellPadding={0} cellSpacing={0}>
                  <thead>
                    <tr className="eVariableheadcolor">
                      <th>全局变量名</th>
                      <th>类型</th>
                      <th className="center width_35">数组</th>
                      <th className="center width_35">公开</th>
                      <th>备注</th>
                    </tr>
                  </thead>
                  {renderRows((row) => (
                    <>
                      <td className="Variablescolor">{row.name}</td>
                      <td className="type">{row.typeName}</td>
                      <td className="eArraycolor epl-array-cell">
                        {row.arraySize && row.arraySize !== "0" ? row.arraySize : ""}
                      </td>
                      <td className={cn("gou", row.isPublic && "is-checked")}>
                        {row.isPublic ? "√" : ""}
                      </td>
                      <td className="beizhu">{row.remark}</td>
                    </>
                  ))}
                </table>
              );
            }

            if (block.kind === "常量") {
              return (
                <table key={bIdx} className="variable" cellPadding={0} cellSpacing={0}>
                  <thead>
                    <tr className="eHeadercolor">
                      <th>常量名称</th>
                      <th>常量值</th>
                      <th className="center width_35">公开</th>
                      <th>备 注</th>
                    </tr>
                  </thead>
                  {renderRows((row) => (
                    <>
                      <td className="Variablescolor">{row.name}</td>
                      <td className="conscolor">{row.value}</td>
                      <td className={cn("gou", row.isPublic && "is-checked")}>
                        {row.isPublic ? "√" : ""}
                      </td>
                      <td className="beizhu">{row.remark}</td>
                    </>
                  ))}
                </table>
              );
            }

            const nameLabel = "变量名";
            return (
              <table key={bIdx} className="variable" cellPadding={0} cellSpacing={0}>
                <thead>
                  <tr className="eVariableheadcolor">
                    <th>{nameLabel}</th>
                    <th>类 型</th>
                    <th className="center width_35">静态</th>
                    <th className="center width_35">数组</th>
                    <th>备注</th>
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, ri) => {
                    nextLineNo();
                    return (
                      <tr key={ri}>
                        <td className="Variablescolor">{row.name}</td>
                        <td className="type">{row.typeName}</td>
                        <td className={cn("gou", row.isStatic && "is-checked")}>
                          {row.isStatic ? "√" : ""}
                        </td>
                        <td className="eArraycolor epl-array-cell">
                          {row.arraySize && row.arraySize !== "0" ? row.arraySize : ""}
                        </td>
                        <td className="beizhu">{row.remark}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            );
          }

          case "code": {
            const tree = buildCodeTree(block.lines);
            return (
              <div key={bIdx} className="epl-source-stream">
                {renderCodeNodes(tree, showLineNumbers, nextLineNo)}
              </div>
            );
          }
        }
      })}
    </div>
  );
}
