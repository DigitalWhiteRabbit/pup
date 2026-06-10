import type { ContentCardView } from "@/lib/content/types";
import { gates, isOverdue, isReady, todayStr } from "@/lib/content/derive";

export const METRIC_LABEL: Record<string, string> = {
  overdue: "Просрочено",
  today: "Сегодня",
  notext: "Без текста",
  review: "На вычитке",
  highprio: "Высокий приоритет",
  ready: "К публикации",
  novisual: "Визуал не готов",
  needvisual: "Согласовать визуал",
  changes: "Нужны правки",
  nodate: "Без даты",
  noowner: "Без ответственного",
  checked: "Проверено",
  visualok: "Визуал ОК",
  published: "Опубликовано",
};

/** Проходит ли карточка под активную метрику-фильтр (как в прототипе). */
export function passMetric(c: ContentCardView, key: string | null): boolean {
  switch (key) {
    case "overdue":
      return isOverdue(c);
    case "today":
      return c.publishDate === todayStr();
    case "notext":
      return !gates(c).text;
    case "review":
      return c.status === "REVIEW";
    case "ready":
      return isReady(c) && c.status !== "PUBLISHED";
    case "novisual":
      return !c.visualApproved;
    case "needvisual":
      return c.visualStatus === "IN_REVIEW";
    case "changes":
      return !!c.adminComment && c.status === "DRAFT";
    case "nodate":
      return !c.publishDate;
    case "noowner":
      return !c.assignee;
    case "highprio":
      return c.priority === "HIGH";
    case "checked":
      return c.proofChecked;
    case "visualok":
      return c.visualApproved;
    case "published":
      return c.status === "PUBLISHED";
    default:
      return true;
  }
}
