import "server-only";
import { getEnv } from "@/lib/env";
import { LocalFileStorage, type FileStorage } from "@/lib/file-storage";

let instance: FileStorage | undefined;

/** The app's patient-file storage (FILE_STORAGE_DIR). */
export function getFileStorage(): FileStorage {
  instance ??= new LocalFileStorage(getEnv().FILE_STORAGE_DIR);
  return instance;
}
