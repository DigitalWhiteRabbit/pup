/**
 * Unified UI color constants for priority and status indicators.
 *
 * Single source of truth -- import these instead of defining local copies
 * in each component. All values are Tailwind utility class strings.
 */

// ─── Priority ────────────────────────────────────────────────────────────────

export const PRIORITY_COLORS = {
  URGENT: {
    bg: "bg-red-100 dark:bg-red-900/30",
    text: "text-red-700 dark:text-red-400",
  },
  HIGH: {
    bg: "bg-orange-100 dark:bg-orange-900/30",
    text: "text-orange-700 dark:text-orange-400",
  },
  MEDIUM: {
    bg: "bg-yellow-100 dark:bg-yellow-900/30",
    text: "text-yellow-700 dark:text-yellow-400",
  },
  LOW: {
    bg: "bg-blue-100 dark:bg-blue-900/30",
    text: "text-blue-700 dark:text-blue-400",
  },
  NONE: {
    bg: "bg-gray-100 dark:bg-gray-800",
    text: "text-gray-600 dark:text-gray-400",
  },
} as const;

/** Flat helper — returns "bg-… text-…" string for contexts that just need a single className. */
export function priorityColorClass(priority: string): string {
  const c = PRIORITY_COLORS[priority as keyof typeof PRIORITY_COLORS];
  return c ? `${c.bg} ${c.text}` : "";
}

export const PRIORITY_LABELS: Record<string, string> = {
  LOW: "Низкий",
  MEDIUM: "Средний",
  HIGH: "Высокий",
  URGENT: "Срочный",
};

// ─── Ticket Status ───────────────────────────────────────────────────────────

/** Badge-style colors (background + text) for ticket statuses. */
export const STATUS_BADGE_COLORS: Record<string, string> = {
  OPEN: "bg-blue-100 text-blue-700",
  IN_PROGRESS: "bg-emerald-100 text-emerald-700",
  WAITING_CUSTOMER: "bg-amber-100 text-amber-700",
  RESOLVED: "bg-gray-100 text-gray-600",
  CLOSED: "bg-gray-100 text-muted-foreground",
};

/** Dot-only colors for compact status indicators (sidebar lists, etc.). */
export const STATUS_DOT_COLORS: Record<string, string> = {
  OPEN: "bg-emerald-500",
  IN_PROGRESS: "bg-blue-500",
  WAITING_CUSTOMER: "bg-amber-500",
  RESOLVED: "bg-gray-400",
  CLOSED: "bg-gray-400",
};

export const STATUS_LABELS: Record<string, string> = {
  OPEN: "Открыт",
  IN_PROGRESS: "В работе",
  WAITING_CUSTOMER: "Ждёт клиента",
  RESOLVED: "Решён",
  CLOSED: "Закрыт",
};
