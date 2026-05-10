import { z } from "zod";

// ─── Article ──────────────────────────────────────────────────────────────────

export const createArticleSchema = z.object({
  title: z
    .string()
    .min(1, "Заголовок обязателен")
    .max(200, "Максимум 200 символов"),
  content: z.string().default(""),
  categoryId: z.string().nullable().optional(),
  tagIds: z.array(z.string()).optional(),
  isPublished: z.boolean().optional().default(true),
});

export const updateArticleSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().optional(),
  categoryId: z.string().nullable().optional(),
  tagIds: z.array(z.string()).optional(),
  isPublished: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});

export const listArticlesSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
  categoryId: z.string().optional(),
  tagIds: z.string().optional(), // comma-separated
  authorId: z.string().optional(),
  isPublished: z.coerce.boolean().optional(),
  search: z.string().optional(),
});

// ─── Category ─────────────────────────────────────────────────────────────────

export const createCategorySchema = z.object({
  name: z.string().min(1, "Название обязательно").max(100),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Некорректный цвет"),
  icon: z.string().max(50).optional(),
  position: z.number().int().optional(),
});

export const updateCategorySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  icon: z.string().max(50).nullable().optional(),
});

export const reorderCategoriesSchema = z.object({
  categoryIds: z.array(z.string()).min(1),
});

// ─── Tag ──────────────────────────────────────────────────────────────────────

export const createTagSchema = z.object({
  name: z.string().min(1, "Название обязательно").max(50),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Некорректный цвет"),
});

export const listTagsSchema = z.object({
  search: z.string().optional(),
});

export type CreateArticleInput = z.infer<typeof createArticleSchema>;
export type UpdateArticleInput = z.infer<typeof updateArticleSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type CreateTagInput = z.infer<typeof createTagSchema>;
