import { z } from "zod";

export const createWorkspaceSchema = z.object({
  name: z
    .string()
    .min(1, "Название обязательно")
    .max(100, "Максимум 100 символов"),
  description: z.string().max(500, "Максимум 500 символов").optional(),
});

export const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
});

export const addMemberSchema = z.object({
  loginOrEmail: z.string().min(1, "Введите логин или email участника"),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export const setModuleEnabledSchema = z.object({
  enabled: z.boolean(),
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;
export type AddMemberInput = z.infer<typeof addMemberSchema>;
export type PaginationInput = z.infer<typeof paginationSchema>;
