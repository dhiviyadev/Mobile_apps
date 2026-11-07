import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

function CodeBlock({ children, lang }: { children: ReactNode; lang: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group my-3 overflow-hidden rounded-xl border border-line bg-black/30">
      <div className="flex h-8 items-center justify-between border-b border-line-soft px-3 text-[11px] text-muted">
        <span className="font-mono">{lang || "text"}</span>
        <button
          className="flex items-center gap-1 opacity-60 transition-opacity hover:text-fg group-hover:opacity-100"
          onClick={() => {
            void navigator.clipboard.writeText(textOf(children));
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

/** Markdown with GFM + syntax highlighting. Raw HTML is never rendered (react-markdown default). */
export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`prose-nexus ${streaming ? "caret" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => {
            const child = Array.isArray(children) ? children[0] : children;
            const className = (child as { props?: { className?: string } })?.props?.className ?? "";
            const lang = /language-([\w-]+)/.exec(className)?.[1] ?? "";
            return <CodeBlock lang={lang}>{children}</CodeBlock>;
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
