/**
 * Контент-план — типы данных, общие для сервера и клиента (type-only, client-safe).
 */
import type {
  CardChannel,
  CardFormat,
  CardPriority,
  CardStatus,
  MediaType,
  VisualStatus,
} from "./constants";

export type ContentMediaView = {
  id: string;
  type: MediaType;
  /** Для IMAGE — отдаётся /api .../media/[id]; для VIDEO — внешняя ссылка. */
  src: string;
  /** Сырое значение url из БД (storagePath для фото, ссылка для видео). */
  url: string;
  name: string | null;
  order: number;
};

export type ContentHistoryEntry = {
  id: string;
  at: string; // ISO datetime
  userLogin: string;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
};

export type ContentCardView = {
  id: string;
  workspaceId: string;
  author: { id: string; login: string } | null;
  assignee: { id: string; login: string } | null;
  title: string;
  channel: CardChannel;
  format: CardFormat;
  priority: CardPriority;
  status: CardStatus;
  visualStatus: VisualStatus;
  publishDate: string | null; // "YYYY-MM-DD"
  visualBrief: string | null;
  visualLink: string | null;
  text: string | null;
  workComment: string | null;
  adminComment: string | null;
  publishedUrl: string | null;
  publishedExternalId: string | null;
  autoPublish: boolean;
  proofChecked: boolean;
  visualApproved: boolean;
  media: ContentMediaView[];
  history: ContentHistoryEntry[];
  createdAt: string;
  updatedAt: string;
};

export type ContentCardInput = {
  title: string;
  channel: CardChannel;
  format: CardFormat;
  priority: CardPriority;
  status?: CardStatus;
  visualStatus?: VisualStatus;
  publishDate?: string | null;
  assigneeId?: string | null;
  visualBrief?: string | null;
  visualLink?: string | null;
  text?: string | null;
  workComment?: string | null;
  adminComment?: string | null;
  autoPublish?: boolean;
};

export type ContentFilter = {
  search?: string;
  channel?: CardChannel;
  status?: CardStatus;
  priority?: CardPriority;
  format?: CardFormat;
};

export type CardAction =
  | "review"
  | "request-changes"
  | "approve"
  | "approve-visual"
  | "publish";

// ─── Дашборд ───────────────────────────────────────────────────────────────────

export type ContentSummary = {
  kpi: {
    total: number;
    review: number;
    checked: number;
    visualOk: number;
    toPublish: number;
    published: number;
  };
  coverage: {
    checkPercent: number;
    checkedOf: { done: number; total: number };
    linkPercent: number;
    linkOf: { done: number; total: number };
  };
  metrics: Record<string, number>;
  channels: Array<{ channel: CardChannel; count: number }>;
};
