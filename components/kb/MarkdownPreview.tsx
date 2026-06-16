"use client";

import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Options as SanitizeSchema } from "rehype-sanitize";

// KB content is now imported from arbitrary external sites (URL import + crawl),
// so it is UNTRUSTED stored markdown. @uiw/react-md-editor renders raw HTML
// (rehype-raw) and overrides urlTransform to identity by default — i.e. no
// sanitization — which allows <img onerror>, raw <script>/<iframe>, and
// javascript:/data: links. We pass rehype-sanitize: it runs AFTER rehype-raw
// in the library's plugin chain, so it strips dangerous tags/attributes from the
// parsed HTML, and defaultSchema's href/src protocol allowlist drops
// javascript:/data: URLs. Keep `className` so syntax highlighting still renders.
const sanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className"],
  },
};

// MDEditor bundles its own markdown preview — use it directly
const MDEditorPreview = dynamic(
  () =>
    import("@uiw/react-md-editor").then((m) => {
      const Comp = ({ source }: { source: string }) => (
        <m.default.Markdown
          source={source}
          rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
        />
      );
      Comp.displayName = "MDEditorPreview";
      return Comp;
    }),
  { ssr: false },
);

type Props = { source: string };

export function MarkdownPreview({ source }: Props) {
  const { resolvedTheme } = useTheme();

  return (
    <div
      data-color-mode={resolvedTheme === "dark" ? "dark" : "light"}
      className="prose max-w-none"
    >
      <MDEditorPreview source={source} />
    </div>
  );
}
