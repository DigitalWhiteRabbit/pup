"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders chat message content with:
 * - @mentions highlighting
 * - Markdown: **bold**, *italic*, `code`, ```code blocks```, lists, links
 * - URL auto-linking via remark-gfm
 */
export function MessageContent({
  content,
  isMe,
}: {
  content: string;
  isMe: boolean;
}) {
  // First, handle @mentions by wrapping them in a special marker
  // that won't be consumed by markdown
  const processed = content.replace(
    /@(\w+)/g,
    '**<span class="mention">@$1</span>**',
  );

  return (
    <div className={`chat-md ${isMe ? "chat-md-me" : "chat-md-other"}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Override link rendering
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
          // Code blocks
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
            // Inline code (no className means inline)
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
            // Block code (has className like "language-js")
            return <code className={className}>{children}</code>;
          },
          // Paragraphs — no extra margin in chat
          p: ({ children }) => <span>{children}</span>,
          // Strong with mention detection
          strong: ({ children }) => {
            // Check if this is a mention wrapper
            const child = Array.isArray(children) ? children[0] : children;
            if (
              typeof child === "object" &&
              child !== null &&
              "props" in child
            ) {
              const props = child.props as {
                dangerouslySetInnerHTML?: { __html: string };
              };
              if (props.dangerouslySetInnerHTML?.__html?.includes("mention")) {
                return child;
              }
            }
            return (
              <strong className={isMe ? "font-bold" : "font-bold"}>
                {children}
              </strong>
            );
          },
          // Lists
          ul: ({ children }) => (
            <ul className="list-disc ml-4 my-0.5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal ml-4 my-0.5">{children}</ol>
          ),
          li: ({ children }) => <li className="text-sm">{children}</li>,
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Simple @mention highlighter (no markdown, for "my" messages or fallback)
 */
export function HighlightMentions({
  content,
  isMe,
}: {
  content: string;
  isMe: boolean;
}) {
  return (
    <>
      {content.split(/(@\w+)/g).map((p, i) =>
        p.startsWith("@") ? (
          <span
            key={i}
            className={`font-medium rounded px-0.5 ${
              isMe ? "text-white bg-white/15" : "text-emerald-600 bg-emerald-50"
            }`}
          >
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}
