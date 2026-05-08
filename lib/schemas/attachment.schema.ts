import { z } from "zod";

// No file size limit enforced at application level (spec FR-025)
// Disk space management is an infrastructure responsibility

export const attachmentMetaSchema = z.object({
  originalName: z.string().min(1).max(255),
  size: z.number().int().min(1),
  mimeType: z.string().min(1),
});

export type AttachmentMetaInput = z.infer<typeof attachmentMetaSchema>;
