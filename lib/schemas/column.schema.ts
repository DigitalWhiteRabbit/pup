import { z } from "zod";

export const createColumnSchema = z.object({
  name: z
    .string()
    .min(1, "Название обязательно")
    .max(100, "Максимум 100 символов"),
});

export const updateColumnSchema = z.object({
  name: z.string().min(1).max(100),
});

export const reorderColumnSchema = z.object({
  position: z.number().int().min(0),
});

export type CreateColumnInput = z.infer<typeof createColumnSchema>;
export type UpdateColumnInput = z.infer<typeof updateColumnSchema>;
export type ReorderColumnInput = z.infer<typeof reorderColumnSchema>;
