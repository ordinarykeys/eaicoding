import type { GrammarState, HighlighterCore, ThemedToken } from "shiki/core";

/** Completed lines retain their tokens; only the growing tail re-enters Shiki. */
export class CodeHighlightCache {
  private prefix = "";
  private lines: ThemedToken[][] = [];
  private state: GrammarState | undefined;
  private language = "";
  private theme = "";
  private highlighter: HighlighterCore | undefined;

  update(highlighter: HighlighterCore, code: string, language: string, theme: string): ThemedToken[][] {
    if (this.highlighter !== highlighter || this.language !== language || this.theme !== theme || !code.startsWith(this.prefix)) {
      this.prefix = "";
      this.lines = [];
      this.state = undefined;
      this.highlighter = highlighter;
      this.language = language;
      this.theme = theme;
    }
    const lang = highlighter.getLoadedLanguages().includes(language as never) ? language : "text";
    const tokenize = (text: string) => highlighter.codeToTokensBase(text, {
      lang, theme, grammarState: this.state, tokenizeMaxLineLength: 2000,
    });
    const rest = code.slice(this.prefix.length);
    const newline = rest.lastIndexOf("\n");
    if (newline >= 0) {
      // Exclude the delimiter: tokenizing an extra empty line would advance
      // TextMate's state twice before the next streaming fragment arrives.
      const end = rest[newline - 1] === "\r" ? newline - 1 : newline;
      const completed = tokenize(rest.slice(0, end));
      this.lines.push(...completed);
      this.state = highlighter.getLastGrammarState(completed);
      this.prefix += rest.slice(0, newline + 1);
    }
    return [...this.lines, ...tokenize(rest.slice(newline + 1))];
  }
}
