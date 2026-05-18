"use client";

export function YouTubeParserClient({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="h-[calc(100vh-4rem)] w-full">
      <iframe
        src={`/parser/youtube.html?workspaceId=${workspaceId}`}
        className="h-full w-full border-0"
        title="YouTube Parser"
      />
    </div>
  );
}
