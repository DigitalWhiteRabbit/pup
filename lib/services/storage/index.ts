import "server-only";
import { LocalStorage } from "./local.storage";
import type { FileStorage } from "./types";

export function getStorage(): FileStorage {
  const driver = process.env["STORAGE_DRIVER"] ?? "local";
  const uploadDir = process.env["UPLOAD_DIR"] ?? "./uploads";

  switch (driver) {
    case "local":
      return new LocalStorage(uploadDir);
    default:
      throw new Error(`Unknown storage driver: ${driver}`);
  }
}

let _storage: FileStorage | null = null;
export function storage(): FileStorage {
  if (!_storage) _storage = getStorage();
  return _storage;
}

export type { FileStorage, UploadInput, StorageResult } from "./types";
export { StorageError } from "./types";
