import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { LocalStorage } from "@/lib/services/storage/local.storage";

// LocalStorage doesn't import "server-only" at runtime in tests
// because vitest resolves it — but we need the mock anyway
import { vi } from "vitest";
vi.mock("server-only", () => ({}));

let tmpDir: string;
let storage: LocalStorage;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-test-"));
  storage = new LocalStorage(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("LocalStorage", () => {
  const input = {
    projectId: "proj1",
    taskId: "task1",
    originalName: "document.pdf",
    buffer: Buffer.from("hello world"),
    mimeType: "application/pdf",
  };

  describe("upload", () => {
    it("creates file at correct path structure", async () => {
      const result = await storage.upload(input);

      expect(result.storagePath).toMatch(
        /^proj1\/task1\/[0-9a-f-]+-document\.pdf$/,
      );
      expect(result.size).toBe(11);
      expect(result.mimeType).toBe("application/pdf");

      const absolutePath = path.join(tmpDir, result.storagePath);
      const content = await fs.readFile(absolutePath, "utf-8");
      expect(content).toBe("hello world");
    });

    it("sanitizes dangerous filenames (path traversal)", async () => {
      const result = await storage.upload({
        ...input,
        originalName: "../../../etc/passwd",
      });

      expect(result.storagePath).not.toContain("..");
      expect(result.storagePath).toMatch(/proj1\/task1\//);
    });

    it("handles empty filename after sanitization", async () => {
      const result = await storage.upload({
        ...input,
        originalName: "....",
      });

      expect(result.storagePath).toMatch(/proj1\/task1\/[0-9a-f-]+-file$/);
    });

    it("strips null bytes and slashes", async () => {
      const result = await storage.upload({
        ...input,
        originalName: "file\0name/with\\slashes.txt",
      });

      expect(result.storagePath).not.toContain("\0");
      expect(result.storagePath).toMatch(
        /proj1\/task1\/[0-9a-f-]+-filenamewithslashes\.txt$/,
      );
    });
  });

  describe("download", () => {
    it("returns a readable stream with file content", async () => {
      const { storagePath } = await storage.upload(input);

      const stream = await storage.download(storagePath);
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const text = Buffer.concat(chunks).toString("utf-8");
      expect(text).toBe("hello world");
    });

    it("throws NOT_FOUND for missing file", async () => {
      await expect(storage.download("nonexistent/path")).rejects.toThrow(
        "Файл не найден",
      );
    });
  });

  describe("delete", () => {
    it("removes the file from disk", async () => {
      const { storagePath } = await storage.upload(input);
      const absolutePath = path.join(tmpDir, storagePath);

      await storage.delete(storagePath);

      await expect(fs.access(absolutePath)).rejects.toThrow();
    });

    it("does not throw for missing file (idempotent)", async () => {
      await expect(storage.delete("nonexistent/file")).resolves.not.toThrow();
    });
  });

  describe("exists", () => {
    it("returns true for existing file", async () => {
      const { storagePath } = await storage.upload(input);
      expect(await storage.exists(storagePath)).toBe(true);
    });

    it("returns false for missing file", async () => {
      expect(await storage.exists("nonexistent/file")).toBe(false);
    });
  });

  describe("path traversal protection", () => {
    it("rejects download with path traversal", async () => {
      await expect(storage.download("../../etc/passwd")).rejects.toThrow(
        "Недопустимый путь",
      );
    });

    it("rejects delete with path traversal", async () => {
      await expect(storage.delete("../../etc/passwd")).rejects.toThrow(
        "Недопустимый путь",
      );
    });
  });
});
