"use client";

import { useEffect } from "react";

export function YouTubeParserClient({
  workspaceId: _workspaceId,
}: {
  workspaceId: string;
}) {
  useEffect(() => {
    window.location.href = "/yt-parser/";
  }, []);

  return (
    <div className="flex h-screen items-center justify-center">
      <p className="text-muted-foreground">Загрузка парсера...</p>
    </div>
  );
}
