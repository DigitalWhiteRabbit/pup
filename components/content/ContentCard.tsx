"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useContent } from "./context";
import { MediaBlock } from "./MediaBlock";
import type { ContentCardView } from "@/lib/content/types";
import {
  CHANNEL_LABEL,
  FORMAT_LABEL,
  PRIORITY_LABEL,
  STATUS_COLOR,
  STATUS_LABEL,
  STATUS_ORDER,
  VISUAL_LABEL,
  type CardStatus,
} from "@/lib/content/constants";
import {
  charInfo,
  fmtShort,
  gates,
  isOverdue,
  isReady,
  nextStep,
  readyCount,
} from "@/lib/content/derive";

function fmtHistoryTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Автор может выставлять только IDEA/DRAFT/PAUSED (остальное — через действия/модератора)
const AUTHOR_STATUSES: CardStatus[] = ["IDEA", "DRAFT", "PAUSED"];

function StatusSelect({ card }: { card: ContentCardView }) {
  const { doSetStatus, isModerator } = useContent();
  const color = STATUS_COLOR[card.status];
  const options = isModerator
    ? STATUS_ORDER
    : STATUS_ORDER.filter(
        (s) => AUTHOR_STATUSES.includes(s) || s === card.status,
      );
  return (
    <select
      value={card.status}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => void doSetStatus(card.id, e.target.value as CardStatus)}
      className="cursor-pointer rounded-lg border bg-card px-2.5 py-1.5 text-xs font-semibold"
      style={{ color, borderColor: `${color}55` }}
    >
      {options.map((s) => (
        <option key={s} value={s} className="text-foreground">
          {STATUS_LABEL[s]}
        </option>
      ))}
    </select>
  );
}

function Block({
  label,
  amber,
  children,
}: {
  label: string;
  amber?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <div
        className={cn(
          "mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wide",
          amber ? "text-amber-500" : "text-muted-foreground",
        )}
      >
        {label}
      </div>
      <div
        className={cn(
          "whitespace-pre-wrap rounded-lg border bg-background px-3.5 py-3 text-[13px] leading-relaxed",
          amber && "border-l-2 border-l-amber-500 bg-amber-500/5",
        )}
      >
        {children}
      </div>
    </>
  );
}

function Gate({ card }: { card: ContentCardView }) {
  const g = gates(card);
  const items = [
    {
      ok: g.date,
      label: "Дата",
      val: card.publishDate ? fmtShort(card.publishDate) : "не задана",
    },
    { ok: g.text, label: "Текст", val: g.text ? "заполнен" : "пусто" },
    { ok: g.proof, label: "Вычитка", val: g.proof ? "проверено" : "ожидает" },
    {
      ok: g.visual,
      label: "Визуал",
      val: g.visual ? "визуал ок" : VISUAL_LABEL[card.visualStatus],
    },
  ];
  return (
    <div className="my-4 grid grid-cols-2 gap-2.5 md:grid-cols-4">
      {items.map((it) => (
        <div
          key={it.label}
          className={cn(
            "rounded-lg border bg-background px-3.5 py-3",
            it.ok && "border-emerald-500/35 bg-emerald-500/10",
          )}
        >
          <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full bg-muted-foreground",
                it.ok && "bg-emerald-500",
              )}
            />
            {it.label}
          </div>
          <div
            className={cn(
              "mt-1.5 text-[13px] font-semibold",
              it.ok && "text-emerald-500",
            )}
          >
            {it.val}
          </div>
        </div>
      ))}
    </div>
  );
}

const btnBase =
  "inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition disabled:opacity-40 disabled:pointer-events-none";
const btnGhost = "border-transparent hover:bg-accent";

export function ContentCard({
  card,
  modMode = false,
}: {
  card: ContentCardView;
  modMode?: boolean;
}) {
  const {
    isModerator,
    currentUserId,
    expanded,
    toggleExpand,
    openEdit,
    doAction,
    doDuplicate,
    doShiftDate,
    doDelete,
    doSetAdminComment,
  } = useContent();
  const [histOpen, setHistOpen] = useState(false);
  const [adminDraft, setAdminDraft] = useState(card.adminComment ?? "");

  const isOpen = expanded.has(card.id);
  const isAuthor = card.author?.id === currentUserId;
  const canEdit = isModerator || isAuthor;
  const g = gates(card);
  const rc = readyCount(card);
  const ready = isReady(card);
  const overdue = isOverdue(card);

  const imgCount = card.media.filter((m) => m.type === "IMAGE").length;
  const hasVideo = card.media.some((m) => m.type === "VIDEO");
  const mediaTag =
    imgCount || hasVideo
      ? " · " +
        [imgCount ? `${imgCount} фото` : "", hasVideo ? "видео" : ""]
          .filter(Boolean)
          .join(" · ")
      : "";

  const prevSrc = (card.text || card.visualBrief || "")
    .replace(/\s+/g, " ")
    .trim();
  const preview = prevSrc
    ? prevSrc.length > 120
      ? prevSrc.slice(0, 120) + "…"
      : prevSrc
    : "";

  // ── Кнопки воркфлоу ──
  const wf: React.ReactNode[] = [];
  if (modMode || isModerator) {
    wf.push(
      <button
        key="changes"
        className={cn(btnBase, "text-amber-500")}
        onClick={() => void doAction(card.id, "request-changes")}
      >
        {modMode ? "Вернуть на правки" : "Правки"}
      </button>,
    );
    wf.push(
      <button
        key="proof"
        className={btnBase}
        disabled={card.proofChecked}
        onClick={() => void doAction(card.id, "approve")}
      >
        Проверено
      </button>,
    );
    wf.push(
      <button
        key="visual"
        className={btnBase}
        disabled={card.visualApproved}
        onClick={() => void doAction(card.id, "approve-visual")}
      >
        Визуал OK
      </button>,
    );
  } else if (isAuthor && (card.status === "DRAFT" || card.status === "IDEA")) {
    wf.push(
      <button
        key="review"
        className={cn(
          btnBase,
          "bg-primary text-primary-foreground font-semibold",
        )}
        disabled={!g.text}
        onClick={() => void doAction(card.id, "review")}
      >
        Отправить на вычитку
      </button>,
    );
  }
  if (
    !modMode &&
    (isModerator || isAuthor) &&
    ready &&
    card.status !== "PUBLISHED"
  ) {
    wf.push(
      <button
        key="publish"
        className={cn(
          btnBase,
          "border-emerald-500 bg-emerald-500 font-semibold text-emerald-950 hover:bg-emerald-400",
        )}
        onClick={() => void doAction(card.id, "publish")}
      >
        Опубликовать
      </button>,
    );
  }

  return (
    <div
      id={`content-card-${card.id}`}
      className={cn(
        "mb-3.5 rounded-xl border bg-card",
        isOpen ? "p-5" : "p-4",
        overdue && "border-red-500/50",
      )}
    >
      {/* HEAD */}
      <div
        className="flex cursor-pointer items-start gap-3.5"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("select,button,textarea,a"))
            return;
          toggleExpand(card.id);
        }}
      >
        <ChevronRight
          className={cn(
            "mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            isOpen && "rotate-90",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground">
            {fmtShort(card.publishDate)} · {CHANNEL_LABEL[card.channel]} ·{" "}
            {FORMAT_LABEL[card.format]} · {PRIORITY_LABEL[card.priority]}{" "}
            приоритет
            {mediaTag && <span className="text-sky-400">{mediaTag}</span>}
            {overdue && <span className="text-red-500"> · просрочено</span>}
          </div>
          <div className="text-[17px] font-bold tracking-tight">
            {card.title}
          </div>
          {!isOpen && preview && (
            <div className="mt-1.5 max-w-[600px] truncate text-xs text-muted-foreground">
              {preview}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2.5">
          {canEdit ? (
            <StatusSelect card={card} />
          ) : (
            <span
              className="rounded-lg border px-2.5 py-1.5 text-xs font-semibold"
              style={{
                color: STATUS_COLOR[card.status],
                borderColor: `${STATUS_COLOR[card.status]}55`,
              }}
            >
              {STATUS_LABEL[card.status]}
            </span>
          )}
          <span
            className={cn(
              "inline-flex items-center rounded-lg border px-2.5 py-1 text-[11.5px] font-semibold",
              ready
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                : "border-amber-500/30 bg-amber-500/10 text-amber-500",
            )}
          >
            {ready ? "Можно публиковать" : `Готовность ${rc}/4`}
          </span>
          {isOpen && (
            <div className="text-right text-[11px] text-muted-foreground">
              Следующий шаг
              <b className="mt-0.5 block text-xs font-semibold text-sky-400">
                {nextStep(card)}
              </b>
            </div>
          )}
        </div>
      </div>

      {/* BODY */}
      {isOpen && (
        <>
          <div className="my-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-4">
            {[
              ["Приоритет", PRIORITY_LABEL[card.priority]],
              ["Ответственный", card.assignee?.login ?? "—"],
              ["Объём текста", charInfo(card)],
              ["Визуал", VISUAL_LABEL[card.visualStatus]],
            ].map(([l, v]) => (
              <div key={l} className="bg-card px-3.5 py-2.5">
                <div className="text-[10px] font-medium text-muted-foreground">
                  {l}
                </div>
                <div className="mt-1 text-[13px] font-semibold">{v}</div>
              </div>
            ))}
          </div>

          {card.visualBrief && (
            <Block label="ТЗ визуала">{card.visualBrief}</Block>
          )}
          {card.text && <Block label="Финальный текст">{card.text}</Block>}
          <MediaBlock card={card} />
          {card.workComment && (
            <Block label="Рабочий комментарий автора">{card.workComment}</Block>
          )}

          <Gate card={card} />

          {modMode ? (
            <>
              <div className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wide text-amber-500">
                Админ-комментарий
              </div>
              <textarea
                value={adminDraft}
                onChange={(e) => setAdminDraft(e.target.value)}
                onBlur={() => {
                  if (adminDraft !== (card.adminComment ?? ""))
                    void doSetAdminComment(card.id, adminDraft);
                }}
                placeholder="Что исправить перед публикацией…"
                className="min-h-[66px] w-full rounded-lg border border-input bg-background px-3 py-2 text-[13px]"
              />
            </>
          ) : (
            card.adminComment && (
              <Block label="Комментарий администратора" amber>
                {card.adminComment}
              </Block>
            )
          )}

          {/* ACTIONS */}
          <div className="mt-4 flex flex-wrap gap-2 border-t pt-4">
            {wf}
            {(wf.length > 0 || canEdit) && (
              <div className="mx-1 w-px bg-border" />
            )}
            {canEdit && (
              <button
                className={cn(btnBase, btnGhost)}
                onClick={() => openEdit(card)}
              >
                Редактировать
              </button>
            )}
            <button
              className={cn(btnBase, btnGhost)}
              onClick={() => void doDuplicate(card.id)}
            >
              Дублировать
            </button>
            {canEdit && (
              <>
                <button
                  className={cn(btnBase, btnGhost)}
                  onClick={() => void doShiftDate(card.id, -1)}
                >
                  Дата −1
                </button>
                <button
                  className={cn(btnBase, btnGhost)}
                  onClick={() => void doShiftDate(card.id, 1)}
                >
                  Дата +1
                </button>
                <button
                  className={cn(btnBase, btnGhost, "text-red-500")}
                  onClick={() => void doDelete(card.id, card.title)}
                >
                  Удалить
                </button>
              </>
            )}
          </div>

          {/* HISTORY */}
          <div className="mt-3.5">
            <button
              className="inline-flex items-center gap-2 text-[11.5px] text-muted-foreground hover:text-foreground"
              onClick={() => setHistOpen((v) => !v)}
            >
              История правок ({card.history.length})
            </button>
            {histOpen && (
              <div className="mt-2.5">
                {[...card.history].reverse().map((h) => (
                  <div
                    key={h.id}
                    className="flex gap-3 border-b border-border/60 py-1.5 text-[12.5px] last:border-0"
                  >
                    <span className="w-[108px] shrink-0 text-[11px] text-muted-foreground">
                      {fmtHistoryTime(h.at)}
                    </span>
                    <span className="shrink-0 font-semibold text-emerald-500">
                      {h.userLogin}
                    </span>
                    <span className="flex-1 break-words leading-relaxed text-muted-foreground">
                      {h.action}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
