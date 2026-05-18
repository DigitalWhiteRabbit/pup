"use client";

export function YouTubeParserClient({
  workspaceId: _workspaceId,
}: {
  workspaceId: string;
}) {
  return (
    <div className="fixed inset-0 z-10">
      <iframe
        src="/yt-parser/"
        className="h-full w-full border-0"
        title="YouTube Parser"
      />
    </div>
  );
}
