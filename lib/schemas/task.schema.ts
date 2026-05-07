import { z } from "zod";

export const createTaskSchema = z.object({
  title: z
    .string()
    .min(1, "Название обязательно")
    .max(255, "Максимум 255 символов"),
  description: z.string().max(5000, "Максимум 5000 символов").optional(),
  columnId: z.string().min(1),
  assigneeId: z.string().optional().nullable(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).optional().nullable(),
  assigneeId: z.string().optional().nullable(),
});

export const moveTaskSchema = z.object({
  columnId: z.string().min(1, "Целевая колонка обязательна"),
  position: z.number().int().min(0),
});

export const reorderTaskSchema = z.object({
  position: z.number().int().min(0),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type MoveTaskInput = z.infer<typeof moveTaskSchema>;
export type ReorderTaskInput = z.infer<typeof reorderTaskSchema>;
