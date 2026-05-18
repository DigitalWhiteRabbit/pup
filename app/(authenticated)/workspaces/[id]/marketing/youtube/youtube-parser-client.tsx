"use client";

export function YouTubeParserClient({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="fixed inset-0 z-10">
      <iframe
        src={`/parser/youtube.html?workspaceId=${workspaceId}`}
        className="h-full w-full border-0"
        title="YouTube Parser"
      />
    </div>
  );
}
