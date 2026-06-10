/**
 * Контент-план — shared reference data (enum ↔ русские подписи, цвета).
 * Client-safe: НЕ добавляй "server-only" — используется и в UI, и в сервисе.
 */

export type CardStatus =
  | "IDEA"
  | "DRAFT"
  | "REVIEW"
  | "READY"
  | "PUBLISHED"
  | "PAUSED";
export type VisualStatus = "NONE" | "IN_REVIEW" | "OK";
export type CardPriority = "LOW" | "MEDIUM" | "HIGH";
export type CardChannel =
  | "ALL"
  | "TELEGRAM"
  | "INSTAGRAM"
  | "X"
  | "TIKTOK"
  | "YOUTUBE"
  | "FACEBOOK";
export type CardFormat = "POST" | "CAROUSEL" | "REELS" | "STORIES" | "VIDEO";
export type MediaType = "IMAGE" | "VIDEO";

// ─── Подписи ──────────────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<CardStatus, string> = {
  IDEA: "Идея",
  DRAFT: "Черновик",
  REVIEW: "На вычитке",
  READY: "Готово",
  PUBLISHED: "Опубликовано",
  PAUSED: "На паузе",
};

export const VISUAL_LABEL: Record<VisualStatus, string> = {
  NONE: "Нет визуала",
  IN_REVIEW: "Визуал на проверке",
  OK: "Визуал ок",
};

export const PRIORITY_LABEL: Record<CardPriority, string> = {
  HIGH: "Высокий",
  MEDIUM: "Средний",
  LOW: "Низкий",
};

export const CHANNEL_LABEL: Record<CardChannel, string> = {
  ALL: "Все каналы",
  TELEGRAM: "Telegram",
  INSTAGRAM: "Instagram",
  X: "X",
  TIKTOK: "TikTok",
  YOUTUBE: "YouTube",
  FACEBOOK: "Facebook",
};

export const FORMAT_LABEL: Record<CardFormat, string> = {
  POST: "Пост",
  CAROUSEL: "Карусель",
  REELS: "Рилс",
  STORIES: "Сторис",
  VIDEO: "Видео",
};

// Цвет статуса (из прототипа STATUS_COLOR)
export const STATUS_COLOR: Record<CardStatus, string> = {
  IDEA: "#9ca3af",
  DRAFT: "#a78bfa",
  REVIEW: "#f59e0b",
  READY: "#10b981",
  PUBLISHED: "#38bdf8",
  PAUSED: "#6b7280",
};

// ─── Упорядоченные списки для селектов ──────────────────────────────────────────

export const STATUS_ORDER: CardStatus[] = [
  "IDEA",
  "DRAFT",
  "REVIEW",
  "READY",
  "PUBLISHED",
  "PAUSED",
];
export const CHANNEL_ORDER: CardChannel[] = [
  "ALL",
  "TELEGRAM",
  "INSTAGRAM",
  "X",
  "TIKTOK",
  "YOUTUBE",
  "FACEBOOK",
];
export const FORMAT_ORDER: CardFormat[] = [
  "POST",
  "CAROUSEL",
  "REELS",
  "STORIES",
  "VIDEO",
];
export const PRIORITY_ORDER: CardPriority[] = ["HIGH", "MEDIUM", "LOW"];
export const VISUAL_ORDER: VisualStatus[] = ["NONE", "IN_REVIEW", "OK"];
