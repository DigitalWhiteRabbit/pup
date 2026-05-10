"use client";

import dynamic from "next/dynamic";
import { useTheme } from "next-themes";

const MDEditor = dynamic(() => import("@uiw/react-md-editor"), { ssr: false });

type Props = {
  value: string;
  onChange: (value: string) => void;
  height?: number;
  preview?: "live" | "edit" | "preview";
};

export function MarkdownEditor({
  value,
  onChange,
  height = 400,
  preview = "live",
}: Props) {
  const { resolvedTheme } = useTheme();

  return (
    <div data-color-mode={resolvedTheme === "dark" ? "dark" : "light"}>
      <MDEditor
        value={value}
        onChange={(v) => onChange(v ?? "")}
        height={height}
        preview={preview}
        hideToolbar={false}
        visibleDragbar={false}
      />
    </div>
  );
}
