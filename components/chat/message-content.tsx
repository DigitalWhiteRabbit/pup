"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders chat message content with:
 * - @mentions highlighting (split before markdown)
 * - Markdown: **bold**, *italic*, `code`, ```code blocks```, lists, links
 */
export function MessageContent({
  content,
  isMe,
}: {
  content: string;
  isMe: boolean;
}) {
  // Split content into segments: text and @mentions
  const segments = content.split(/(@\w+)/g);

  return (
    <span>
      {segments.map((seg, i) =>
        seg.startsWith("@") ? (
          <span
            key={i}
            className={`font-medium rounded px-0.5 ${
              isMe
                ? "text-white bg-white/15"
                : "text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30"
            }`}
          >
            {seg}
          </span>
        ) : (
          <MdSegment key={i} text={seg} isMe={isMe} />
        ),
      )}
    </span>
  );
}

function MdSegment({ text, isMe }: { text: string; isMe: boolean }) {
  // If no markdown syntax, render as plain text for performance
  if (!/[*_`~\[\]#>|-]/.test(text) && !/https?:\/\//.test(text)) {
    return <>{text}</>;
  }

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={
              isMe
                ? "underline text-white/90 hover:text-white"
                : "underline text-emerald-600 hover:text-emerald-700"
            }
          >
            {children}
          </a>
        ),
        pre: ({ children }) => (
          <pre
            className={`mt-1 mb-1 p-2 rounded-lg text-xs overflow-x-auto ${
              isMe ? "bg-white/10 text-white" : "bg-muted text-foreground"
            }`}
          >
            {children}
          </pre>
        ),
        code: ({ children, className }) => {
          if (!className) {
            return (
              <code
                className={`px-1 py-0.5 rounded text-xs font-mono ${
                  isMe
                    ? "bg-white/15 text-white"
                    : "bg-muted text-rose-600 dark:text-rose-400"
                }`}
              >
                {children}
              </code>
            );
          }
          return <code className={className}>{children}</code>;
        },
        p: ({ children }) => <span>{children}</span>,
        strong: ({ children }) => (
          <strong className="font-bold">{children}</strong>
        ),
        ul: ({ children }) => (
          <ul className="list-disc ml-4 my-0.5">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="list-decimal ml-4 my-0.5">{children}</ol>
        ),
        li: ({ children }) => <li className="text-sm">{children}</li>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
