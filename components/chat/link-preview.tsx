"use client";

import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";

type PreviewData = {
  title: string | null;
  description: string | null;
  image: string | null;
  url: string;
};

/** Extract first URL from text */
export function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>)"']+/);
  return match ? match[0] : null;
}

export function LinkPreview({ url, isMe }: { url: string; isMe: boolean }) {
  const { data } = useQuery<PreviewData>({
    queryKey: ["link-preview", url],
    queryFn: () =>
      fetch(`/api/link-preview?url=${encodeURIComponent(url)}`).then((r) => {
        if (!r.ok) throw new Error("fail");
        return r.json();
      }),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  if (!data || (!data.title && !data.description)) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`block mt-1.5 rounded-lg overflow-hidden border text-left ${
        isMe
          ? "border-white/20 bg-white/10 hover:bg-white/15"
          : "border-border bg-muted/50 hover:bg-muted"
      } transition-colors`}
    >
      {data.image && (
        <div className="h-28 overflow-hidden">
          <img src={data.image} alt="" className="w-full h-full object-cover" />
        </div>
      )}
      <div className="px-2.5 py-2">
        {data.title && (
          <div
            className={`text-xs font-semibold line-clamp-1 ${
              isMe ? "text-white" : "text-foreground"
            }`}
          >
            {data.title}
          </div>
        )}
        {data.description && (
          <div
            className={`text-[11px] line-clamp-2 mt-0.5 ${
              isMe ? "text-white/70" : "text-muted-foreground"
            }`}
          >
            {data.description}
          </div>
        )}
        <div
          className={`flex items-center gap-1 mt-1 text-[10px] ${
            isMe ? "text-white/50" : "text-gray-400"
          }`}
        >
          <ExternalLink className="h-2.5 w-2.5" />
          {new URL(url).hostname}
        </div>
      </div>
    </a>
  );
}
