"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toastSuccess, toastError } from "@/lib/toast";
import type { ContentCardView } from "@/lib/content/types";
import type { ContentMember } from "./context";
import {
  CHANNEL_LABEL,
  CHANNEL_ORDER,
  FORMAT_LABEL,
  FORMAT_ORDER,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  type CardChannel,
  type CardFormat,
  type CardPriority,
} from "@/lib/content/constants";

type FormState = {
  publishDate: string;
  channel: CardChannel;
  format: CardFormat;
  priority: CardPriority;
  title: string;
  assigneeId: string;
  visualBrief: string;
  text: string;
  videoUrl: string;
  workComment: string;
};

const EMPTY: FormState = {
  publishDate: "",
  channel: "TELEGRAM",
  format: "POST",
  priority: "MEDIUM",
  title: "",
  assigneeId: "",
  visualBrief: "",
  text: "",
  videoUrl: "",
  workComment: "",
};

const labelCls = "mb-1.5 block text-[11px] font-medium text-muted-foreground";
const inputCls =
  "w-full rounded-lg border border-input bg-background px-3 py-2 text-[13px] focus:border-ring focus:outline-none";
const areaCls = inputCls + " min-h-[66px] resize-y leading-relaxed";

export function CardModal({
  open,
  card,
  members,
  workspaceId,
  onClose,
  onComplete,
}: {
  open: boolean;
  card: ContentCardView | null; // null = создание
  members: ContentMember[];
  workspaceId: string;
  onClose: () => void;
  onComplete: (newCardId?: string) => void;
}) {
  const isEdit = !!card;
  const [form, setForm] = useState<FormState>(EMPTY);
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [existingImages, setExistingImages] = useState<
    { id: string; src: string }[]
  >([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [originalVideo, setOriginalVideo] = useState<{
    id: string;
    url: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (card) {
      setForm({
        publishDate: card.publishDate ?? "",
        channel: card.channel,
        format: card.format,
        priority: card.priority,
        title: card.title,
        assigneeId: card.assignee?.id ?? "",
        visualBrief: card.visualBrief ?? "",
        text: card.text ?? "",
        videoUrl: card.media.find((m) => m.type === "VIDEO")?.url ?? "",
        workComment: card.workComment ?? "",
      });
      setExistingImages(
        card.media
          .filter((m) => m.type === "IMAGE")
          .map((m) => ({ id: m.id, src: m.src })),
      );
      const vid = card.media.find((m) => m.type === "VIDEO");
      setOriginalVideo(vid ? { id: vid.id, url: vid.url } : null);
    } else {
      setForm({ ...EMPTY, publishDate: new Date().toISOString().slice(0, 10) });
      setExistingImages([]);
      setOriginalVideo(null);
    }
    setNewFiles([]);
    setRemovedIds([]);
  }, [open, card]);

  const upd = (patch: Partial<FormState>) =>
    setForm((f) => ({ ...f, ...patch }));
  const base = `/api/workspaces/${workspaceId}/content`;

  async function jsonReq(url: string, method: string, body?: unknown) {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? "Ошибка запроса");
    }
    return res.json().catch(() => ({}));
  }

  async function uploadFile(cardId: string, file: File) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${base}/cards/${cardId}/media`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) throw new Error("Не удалось загрузить фото");
  }

  async function handleSave() {
    if (!form.title.trim()) {
      toastError("Укажи тему публикации");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        channel: form.channel,
        format: form.format,
        priority: form.priority,
        publishDate: form.publishDate || null,
        assigneeId: form.assigneeId || null,
        visualBrief: form.visualBrief,
        text: form.text,
        workComment: form.workComment,
      };

      let cardId: string;
      if (isEdit && card) {
        await jsonReq(`${base}/cards/${card.id}`, "PATCH", payload);
        cardId = card.id;
        // удалённые фото
        for (const id of removedIds) {
          await fetch(`${base}/cards/${cardId}/media/${id}`, {
            method: "DELETE",
          });
        }
      } else {
        const created = (await jsonReq(`${base}/cards`, "POST", payload)) as {
          id: string;
        };
        cardId = created.id;
      }

      // новые фото
      for (const file of newFiles) await uploadFile(cardId, file);

      // видео по ссылке
      const newVideo = form.videoUrl.trim();
      if (newVideo !== (originalVideo?.url ?? "")) {
        if (originalVideo) {
          await fetch(`${base}/cards/${cardId}/media/${originalVideo.id}`, {
            method: "DELETE",
          });
        }
        if (newVideo) {
          await jsonReq(`${base}/cards/${cardId}/media`, "POST", {
            videoUrl: newVideo,
          });
        }
      }

      toastSuccess(isEdit ? "Сохранено" : "Карточка создана");
      onComplete(isEdit ? undefined : cardId);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Редактировать карточку" : "Новая карточка контента"}
          </DialogTitle>
          <p className="text-[12.5px] text-muted-foreground">
            Заполни тему, дату и канал — остальное можно дополнить позже и
            отправить на вычитку.
          </p>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div>
            <label className={labelCls}>Дата</label>
            <input
              type="date"
              value={form.publishDate}
              onChange={(e) => upd({ publishDate: e.target.value })}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Канал</label>
            <select
              className={inputCls}
              value={form.channel}
              onChange={(e) => upd({ channel: e.target.value as CardChannel })}
            >
              {CHANNEL_ORDER.map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Формат</label>
            <select
              className={inputCls}
              value={form.format}
              onChange={(e) => upd({ format: e.target.value as CardFormat })}
            >
              {FORMAT_ORDER.map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABEL[f]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Приоритет</label>
            <select
              className={inputCls}
              value={form.priority}
              onChange={(e) =>
                upd({ priority: e.target.value as CardPriority })
              }
            >
              {PRIORITY_ORDER.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </div>

          <div className="col-span-2">
            <label className={labelCls}>Тема публикации</label>
            <input
              value={form.title}
              onChange={(e) => upd({ title: e.target.value })}
              placeholder="Заголовок карточки"
              className={inputCls}
            />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>Ответственный</label>
            <select
              className={inputCls}
              value={form.assigneeId}
              onChange={(e) => upd({ assigneeId: e.target.value })}
            >
              <option value="">— не назначен —</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.login}
                </option>
              ))}
            </select>
          </div>

          <div className="col-span-2 md:col-span-4">
            <label className={labelCls}>
              ТЗ визуала — что на картинке / видео / обложке
            </label>
            <textarea
              value={form.visualBrief}
              onChange={(e) => upd({ visualBrief: e.target.value })}
              placeholder="Опиши визуал для дизайнера…"
              className={areaCls}
            />
          </div>
          <div className="col-span-2 md:col-span-4">
            <label className={labelCls}>
              Финальный текст / сценарий / тезисы
            </label>
            <textarea
              value={form.text}
              onChange={(e) => upd({ text: e.target.value })}
              placeholder="Текст публикации…"
              className={areaCls}
            />
          </div>

          <div className="col-span-2">
            <label className={labelCls}>Медиа — фото (можно несколько)</label>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => {
                setNewFiles((prev) => [
                  ...prev,
                  ...Array.from(e.target.files ?? []),
                ]);
                e.target.value = "";
              }}
              className="w-full cursor-pointer rounded-lg border border-input bg-background px-3 py-2 text-[12.5px] text-muted-foreground"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              {existingImages.map((img) => (
                <Thumb
                  key={img.id}
                  src={img.src}
                  onRemove={() => {
                    setRemovedIds((r) => [...r, img.id]);
                    setExistingImages((list) =>
                      list.filter((x) => x.id !== img.id),
                    );
                  }}
                />
              ))}
              {newFiles.map((file, i) => (
                <Thumb
                  key={i}
                  src={URL.createObjectURL(file)}
                  onRemove={() =>
                    setNewFiles((list) => list.filter((_, idx) => idx !== i))
                  }
                />
              ))}
            </div>
          </div>
          <div className="col-span-2">
            <label className={labelCls}>
              Медиа — видео по ссылке (Google Drive / файлообменник)
            </label>
            <input
              value={form.videoUrl}
              onChange={(e) => upd({ videoUrl: e.target.value })}
              placeholder="https://drive.google.com/file/d/… или прямая .mp4"
              className={inputCls}
            />
          </div>

          <div className="col-span-2 md:col-span-4">
            <label className={labelCls}>Рабочий комментарий автора</label>
            <textarea
              value={form.workComment}
              onChange={(e) => upd({ workComment: e.target.value })}
              placeholder="Заметки для себя и менеджера…"
              className={areaCls + " min-h-[50px]"}
            />
          </div>
        </div>

        <div className="mt-2 flex justify-end gap-2.5">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving
              ? "Сохранение…"
              : isEdit
                ? "Сохранить"
                : "Добавить карточку"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Thumb({ src, onRemove }: { src: string; onRemove: () => void }) {
  return (
    <div className="relative h-14 w-[74px] overflow-hidden rounded-md border">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className="h-full w-full object-cover" />
      <button
        onClick={onRemove}
        className="absolute -right-1.5 -top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-card bg-red-500 text-white"
        aria-label="Удалить"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}
