/**
 * Контент-план — производные значения (готовность X/4, следующий шаг, объём,
 * «просрочено»). НЕ хранятся в БД — считаются на лету. Client-safe.
 */
import type { ContentCardView } from "./types";

const MONTHS = [
  "янв",
  "фев",
  "мар",
  "апр",
  "мая",
  "июн",
  "июл",
  "авг",
  "сен",
  "окт",
  "ноя",
  "дек",
];

/** Сегодняшняя дата в формате YYYY-MM-DD (локальное время). */
export function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export type Gates = {
  text: boolean;
  proof: boolean;
  visual: boolean;
  date: boolean;
};

export function gates(c: ContentCardView): Gates {
  return {
    text: !!(c.text && c.text.trim().length > 0),
    proof: !!c.proofChecked,
    visual: !!c.visualApproved,
    date: !!c.publishDate,
  };
}

export function readyCount(c: ContentCardView): number {
  const g = gates(c);
  return [g.text, g.proof, g.visual, g.date].filter(Boolean).length;
}

export function isReady(c: ContentCardView): boolean {
  return readyCount(c) === 4;
}

export function isOverdue(c: ContentCardView, today = todayStr()): boolean {
  return (
    !!c.publishDate &&
    c.publishDate < today &&
    c.status !== "PUBLISHED" &&
    c.status !== "PAUSED"
  );
}

export function nextStep(c: ContentCardView): string {
  if (c.status === "PUBLISHED") return "Опубликовано";
  if (c.status === "IDEA") return "Дополнить и в черновик";
  if (!gates(c).text) return "Заполнить текст";
  if (c.status === "DRAFT") return "Отправить на вычитку";
  if (c.status === "REVIEW" && !c.proofChecked)
    return "Ждёт проверки менеджера";
  if (!c.visualApproved) return "Согласовать визуал";
  if (isReady(c)) return "Публиковать";
  return "Уточнить детали";
}

export function charInfo(c: ContentCardView): string {
  const t = (c.text ?? "").trim();
  if (!t) return "нет текста";
  const words = t.split(/\s+/).filter(Boolean).length;
  return `${t.length} симв. / ${words} слов`;
}

/** "2026-05-31" → "31 мая 2026" */
export function fmtDate(d: string | null): string {
  if (!d) return "—";
  const [y, m, dd] = d.split("-");
  return `${parseInt(dd!, 10)} ${MONTHS[parseInt(m!, 10) - 1]} ${y}`;
}

/** "2026-05-31" → "31 мая" */
export function fmtShort(d: string | null): string {
  if (!d) return "—";
  const [, m, dd] = d.split("-");
  return `${parseInt(dd!, 10)} ${MONTHS[parseInt(m!, 10) - 1]}`;
}

/**
 * Безопасна ли ссылка для встраивания (iframe/video): только http(s).
 * Отсекает javascript:/data: и прочие схемы.
 */
export function isSafeEmbedUrl(url: string | null | undefined): boolean {
  return !!url && /^https?:\/\//i.test(url.trim());
}

/** Сдвиг даты YYYY-MM-DD на n дней. */
export function shiftDate(d: string, n: number): string {
  const dt = new Date(d + "T00:00:00.000Z");
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
