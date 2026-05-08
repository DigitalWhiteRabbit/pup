import "server-only";

export interface FileStorage {
  upload(input: UploadInput): Promise<StorageResult>;
  download(storagePath: string): Promise<ReadableStream<Uint8Array>>;
  delete(storagePath: string): Promise<void>;
  exists(storagePath: string): Promise<boolean>;
}

export type UploadInput = {
  projectId: string;
  taskId: string;
  originalName: string;
  buffer: Buffer | Uint8Array;
  mimeType: string;
};

export type StorageResult = {
  storagePath: string;
  size: number;
  mimeType: string;
};

export class StorageError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}
