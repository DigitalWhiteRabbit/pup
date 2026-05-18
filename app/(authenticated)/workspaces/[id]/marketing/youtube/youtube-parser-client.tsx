"use client";

export function YouTubeParserClient({
  workspaceId: _workspaceId,
}: {
  workspaceId: string;
}) {
  return (
    <iframe
      src="/yt-parser/"
      className="h-[calc(100vh-4rem)] w-full border-0"
      title="YouTube Parser"
    />
  );
}
