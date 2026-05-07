import { z } from "zod";

// Max file size: 20 MB
export const MAX_FILE_SIZE = 20 * 1024 * 1024;

export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
  "application/zip",
] as const;

export const attachmentMetaSchema = z.object({
  originalName: z.string().min(1).max(255),
  size: z.number().int().min(1).max(MAX_FILE_SIZE),
  mimeType: z.string().min(1),
});

export type AttachmentMetaInput = z.infer<typeof attachmentMetaSchema>;
