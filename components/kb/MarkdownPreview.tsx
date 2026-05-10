"use client";

import dynamic from "next/dynamic";
import { useTheme } from "next-themes";

// MDEditor bundles its own markdown preview — use it directly
const MDEditorPreview = dynamic(
  () =>
    import("@uiw/react-md-editor").then((m) => {
      const Comp = ({ source }: { source: string }) => (
        <m.default.Markdown source={source} />
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
