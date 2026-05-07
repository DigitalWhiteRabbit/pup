import { z } from "zod";

export const getNotificationsSchema = z.object({
  unreadOnly: z.coerce.boolean().optional().default(false),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

export const markReadSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, "Укажите хотя бы один ID"),
});

export type GetNotificationsInput = z.infer<typeof getNotificationsSchema>;
export type MarkReadInput = z.infer<typeof markReadSchema>;
