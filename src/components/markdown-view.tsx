import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "@/components/code-block";

export function MarkdownView({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || "");
          const text = String(children).replace(/\n$/, "");
          // Inline code if no language and no newline
          if (!match && !text.includes("\n")) {
            return (
              <code
                className="px-1 py-0.5 rounded bg-secondary text-secondary-foreground text-[0.85em] font-mono"
                {...props}
              >
                {children}
              </code>
            );
          }
          return <CodeBlock language={match?.[1] ?? ""} code={text} />;
        },
        a({ children, ...props }) {
          return (
            <a
              {...props}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-2 hover:underline"
            >
              {children}
            </a>
          );
        },
        p({ children }) {
          return <p className="leading-7 my-2 first:mt-0 last:mb-0">{children}</p>;
        },
        ul({ children }) {
          return <ul className="list-disc pl-6 my-2 space-y-1">{children}</ul>;
        },
        ol({ children }) {
          return <ol className="list-decimal pl-6 my-2 space-y-1">{children}</ol>;
        },
        h1({ children }) {
          return <h1 className="text-xl font-bold mt-4 mb-2">{children}</h1>;
        },
        h2({ children }) {
          return <h2 className="text-lg font-bold mt-3 mb-2">{children}</h2>;
        },
        h3({ children }) {
          return <h3 className="text-base font-bold mt-2 mb-1">{children}</h3>;
        },
        blockquote({ children }) {
          return (
            <blockquote className="border-l-4 border-border pl-3 my-2 text-muted-foreground italic">
              {children}
            </blockquote>
          );
        },
        table({ children }) {
          return (
            <div className="overflow-x-auto my-2">
              <table className="border-collapse text-sm">{children}</table>
            </div>
          );
        },
        th({ children }) {
          return (
            <th className="border border-border px-2 py-1 bg-secondary text-left font-medium">
              {children}
            </th>
          );
        },
        td({ children }) {
          return <td className="border border-border px-2 py-1">{children}</td>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
