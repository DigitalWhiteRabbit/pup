"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { isSafeEmbedUrl } from "@/lib/content/derive";
import type { LightboxContent } from "./context";

export function Lightbox({
  content,
  onClose,
}: {
  content: LightboxContent | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!content) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [content, onClose]);

  if (!content) return null;

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm md:p-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button
        onClick={onClose}
        className="absolute right-5 top-4 text-white/80 hover:text-white"
        aria-label="Закрыть"
      >
        <X className="h-7 w-7" />
      </button>
      {content.kind === "image" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={content.src}
          alt=""
          className="max-h-[86vh] max-w-[90vw] rounded-lg border"
        />
      )}
      {content.kind === "iframe" &&
        (isSafeEmbedUrl(content.src) ? (
          <iframe
            src={content.src}
            allow="autoplay"
            allowFullScreen
            className="h-[min(560px,80vh)] w-[min(900px,90vw)] rounded-lg border bg-black"
          />
        ) : (
          <div className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground">
            Небезопасный адрес — встраивание заблокировано.
          </div>
        ))}
      {content.kind === "video" &&
        (isSafeEmbedUrl(content.src) ? (
          <video
            src={content.src}
            controls
            autoPlay
            className="h-[min(560px,80vh)] w-[min(900px,90vw)] rounded-lg border bg-black"
          />
        ) : (
          <div className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground">
            Небезопасный адрес — встраивание заблокировано.
          </div>
        ))}
    </div>
  );
}
