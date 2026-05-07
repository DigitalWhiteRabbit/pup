import { z } from "zod";

export const createCommentSchema = z.object({
  text: z
    .string()
    .min(1, "Комментарий не может быть пустым")
    .max(5000, "Максимум 5000 символов"),
});

export const updateCommentSchema = z.object({
  text: z.string().min(1).max(5000),
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;
