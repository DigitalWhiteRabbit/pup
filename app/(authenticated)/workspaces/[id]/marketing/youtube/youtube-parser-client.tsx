"use client";

export function YouTubeParserClient({ workspaceId }: { workspaceId: string }) {
  return (
    <iframe
      src={`/yt-parser/?workspace=${workspaceId}`}
      className="h-[calc(100vh-4rem)] w-full border-0"
      title="YouTube Parser"
    />
  );
}
