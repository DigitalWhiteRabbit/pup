"use client";

import { HelpCircle } from "lucide-react";
import { useContent } from "./context";
import { isSafeEmbedUrl } from "@/lib/content/derive";
import type { ContentCardView, ContentMediaView } from "@/lib/content/types";

function driveId(url: string): string | null {
  const m = url.match(/\/d\/([\w-]+)/) ?? url.match(/[?&]id=([\w-]+)/);
  return m ? m[1]! : null;
}

function VideoEmbed({ media }: { media: ContentMediaView }) {
  const { openLightbox } = useContent();
  const url = media.url;

  // Встраиваем только безопасные http(s)-ссылки
  if (!isSafeEmbedUrl(url)) {
    return (
      <div className="mt-1 rounded-lg border bg-background px-3.5 py-3 text-xs text-muted-foreground">
        Видео по ссылке недоступно для встраивания (небезопасный адрес):{" "}
        <span className="break-all">{url}</span>
      </div>
    );
  }

  if (/\.mp4(\?|$)/i.test(url)) {
    return (
      <video
        controls
        preload="metadata"
        src={url}
        className="mt-1 block h-[248px] w-full max-w-[440px] rounded-lg border bg-black"
      />
    );
  }
  const id = driveId(url);
  if (id) {
    return (
      <iframe
        src={`https://drive.google.com/file/d/${id}/preview`}
        allow="autoplay"
        allowFullScreen
        className="mt-1 block h-[248px] w-full max-w-[440px] rounded-lg border bg-black"
      />
    );
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2.5 rounded-lg border bg-background px-3.5 py-3 text-xs text-muted-foreground">
      <span>Видео по ссылке:</span>
      <button
        className="font-medium text-emerald-500 hover:underline"
        onClick={() => openLightbox({ kind: "iframe", src: url })}
      >
        смотреть в панели
      </button>
      <span className="break-all">{url}</span>
    </div>
  );
}

export function MediaBlock({ card }: { card: ContentCardView }) {
  const { openLightbox } = useContent();
  if (!card.media.length) return null;

  const images = card.media.filter((m) => m.type === "IMAGE");
  const videos = card.media.filter((m) => m.type === "VIDEO");

  return (
    <div>
      <div className="mb-2 mt-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Медиа
        <HelpCircle
          className="h-3.5 w-3.5"
          aria-label="Фото и видео публикации — проверяются прямо здесь, без перехода наружу"
        />
      </div>
      {images.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-2.5">
          {images.map((m) => (
            <button
              key={m.id}
              title={m.name ?? "фото"}
              onClick={() => openLightbox({ kind: "image", src: m.src })}
              className="h-[72px] w-[96px] overflow-hidden rounded-lg border bg-muted transition hover:-translate-y-px hover:border-emerald-500"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={m.src}
                alt={m.name ?? "фото"}
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
      {videos.map((v) => (
        <VideoEmbed key={v.id} media={v} />
      ))}
    </div>
  );
}
