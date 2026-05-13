import "server-only";
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { FileStorage, UploadInput, StorageResult } from "./types";
import { StorageError } from "./types";

function sanitizeFilename(name: string): string {
  // Remove path traversal characters, null bytes, slashes
  let cleaned = name
    .replace(/\0/g, "")
    .replace(/\.\./g, "")
    .replace(/[/\\]/g, "")
    .trim();
  if (!cleaned) cleaned = "file";
  return cleaned;
}

export class LocalStorage implements FileStorage {
  constructor(private readonly uploadDir: string) {}

  async upload(input: UploadInput): Promise<StorageResult> {
    const uuid = crypto.randomUUID();
    const cleanedName = sanitizeFilename(input.originalName);
    const filename = `${uuid}-${cleanedName}`;

    let storagePath: string;
    if (input.scope === "kb") {
      const wsId = input.workspaceId ?? "unknown";
      storagePath = `kb/${wsId}/files/${filename}`;
    } else if (input.scope === "ticket") {
      const wsId = input.workspaceId ?? "unknown";
      const tktId = input.ticketId ?? "unknown";
      storagePath = `tickets/${wsId}/${tktId}/${filename}`;
    } else if (input.scope === "chat") {
      const wsId = input.workspaceId ?? "unknown";
      const chId = input.channelId ?? "unknown";
      storagePath = `chat/${wsId}/${chId}/${filename}`;
    } else if (input.scope === "persona") {
      const wsId = input.workspaceId ?? "unknown";
      storagePath = `personas/${wsId}/${filename}`;
    } else {
      const projId = input.projectId ?? "unknown";
      const subDir = input.taskId ?? "_kb";
      storagePath = `${projId}/${subDir}/${filename}`;
    }

    const absolutePath = path.join(this.uploadDir, storagePath);
    this.guardPathTraversal(absolutePath);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, input.buffer);

    return {
      storagePath,
      size: input.buffer.length,
      mimeType: input.mimeType,
    };
  }

  async download(storagePath: string): Promise<ReadableStream<Uint8Array>> {
    const absolutePath = path.join(this.uploadDir, storagePath);
    this.guardPathTraversal(absolutePath);

    try {
      await fs.access(absolutePath);
    } catch {
      throw new StorageError("Файл не найден", "NOT_FOUND");
    }

    const nodeStream = createReadStream(absolutePath);
    return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  }

  async delete(storagePath: string): Promise<void> {
    const absolutePath = path.join(this.uploadDir, storagePath);
    this.guardPathTraversal(absolutePath);

    try {
      await fs.unlink(absolutePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  async exists(storagePath: string): Promise<boolean> {
    const absolutePath = path.join(this.uploadDir, storagePath);
    this.guardPathTraversal(absolutePath);

    try {
      await fs.access(absolutePath);
      return true;
    } catch {
      return false;
    }
  }

  private guardPathTraversal(absolutePath: string): void {
    const resolved = path.resolve(absolutePath);
    const base = path.resolve(this.uploadDir);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      throw new StorageError("Недопустимый путь к файлу", "INVALID_PATH");
    }
  }
}
