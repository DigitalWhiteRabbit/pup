import { z } from "zod";

export const channelEnum = z.enum([
  "ALL",
  "TELEGRAM",
  "INSTAGRAM",
  "X",
  "TIKTOK",
  "YOUTUBE",
  "FACEBOOK",
]);
export const formatEnum = z.enum([
  "POST",
  "CAROUSEL",
  "REELS",
  "STORIES",
  "VIDEO",
]);
export const statusEnum = z.enum([
  "IDEA",
  "DRAFT",
  "REVIEW",
  "READY",
  "PUBLISHED",
  "PAUSED",
]);
export const priorityEnum = z.enum(["LOW", "MEDIUM", "HIGH"]);
export const visualEnum = z.enum(["NONE", "IN_REVIEW", "OK"]);

// "YYYY-MM-DD" или null
const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Дата в формате ГГГГ-ММ-ДД")
  .nullable();

export const createCardSchema = z.object({
  title: z.string().trim().min(1, "Укажите тему публикации").max(300),
  channel: channelEnum.default("TELEGRAM"),
  format: formatEnum.default("POST"),
  priority: priorityEnum.default("MEDIUM"),
  status: statusEnum.optional(),
  visualStatus: visualEnum.optional(),
  publishDate: dateStr.optional(),
  assigneeId: z.string().nullable().optional(),
  visualBrief: z.string().nullable().optional(),
  visualLink: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  workComment: z.string().nullable().optional(),
  adminComment: z.string().nullable().optional(),
  autoPublish: z.boolean().optional(),
});

export const updateCardSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  channel: channelEnum.optional(),
  format: formatEnum.optional(),
  priority: priorityEnum.optional(),
  status: statusEnum.optional(),
  visualStatus: visualEnum.optional(),
  publishDate: dateStr.optional(),
  assigneeId: z.string().nullable().optional(),
  visualBrief: z.string().nullable().optional(),
  visualLink: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  workComment: z.string().nullable().optional(),
  adminComment: z.string().nullable().optional(),
  autoPublish: z.boolean().optional(),
});

export const actionSchema = z.object({
  action: z.enum([
    "review",
    "request-changes",
    "approve",
    "approve-visual",
    "publish",
  ]),
  publishedUrl: z.string().url().optional(),
});

export const listFilterSchema = z.object({
  search: z.string().optional(),
  channel: channelEnum.optional(),
  status: statusEnum.optional(),
  priority: priorityEnum.optional(),
  format: formatEnum.optional(),
});

// Разрешаем только http(s)-ссылки (защита от javascript:/data: и пр. при встраивании).
export const httpUrl = z
  .string()
  .trim()
  .min(1, "Укажите ссылку на видео")
  .url("Некорректная ссылка")
  .refine(
    (u) => /^https?:\/\//i.test(u),
    "Ссылка должна начинаться с http:// или https://",
  );

export const addVideoSchema = z.object({
  videoUrl: httpUrl,
  name: z.string().optional(),
});
