import { lstat, readFile } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type {
  OutgoingMediaKind,
  OutgoingMediaMessage,
} from "../../core/types.js";

const MAX_FEISHU_IMAGE_BYTES = 10_000_000;
const MAX_FEISHU_FILE_BYTES = 30_000_000;

const FEISHU_IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".ico", ".tif", ".tiff", ".heic",
]);

export interface LoadedFeishuMedia {
  kind: OutgoingMediaKind;
  bytes: Buffer;
  fileName: string;
  byteLength: number;
}

export async function loadFeishuLocalMedia(
  message: Pick<OutgoingMediaMessage, "kind" | "localPath" | "fileName">,
): Promise<LoadedFeishuMedia> {
  const localPath = message.localPath.trim();
  if (!localPath || !isAbsolute(localPath)) {
    throw new Error("Feishu media localPath must be an absolute path");
  }

  const stat = await lstat(localPath);
  if (stat.isSymbolicLink()) throw new Error("Feishu media symlinks are not allowed");
  if (!stat.isFile()) throw new Error("Feishu media localPath must reference a regular file");
  if (stat.size <= 0) throw new Error("Feishu media file must not be empty");

  const sourceName = basename(localPath);
  const fileName = normalizeFileName(message.fileName ?? sourceName);
  const extension = extname(sourceName).toLowerCase();

  if (message.kind === "image") {
    if (!FEISHU_IMAGE_EXTENSIONS.has(extension)) {
      throw new Error(`Unsupported Feishu image extension: ${extension || "(none)"}`);
    }
    if (stat.size > MAX_FEISHU_IMAGE_BYTES) {
      throw new Error("Feishu image exceeds the 10 MB platform limit");
    }
  } else if (stat.size > MAX_FEISHU_FILE_BYTES) {
    throw new Error("Feishu file exceeds the 30 MB platform limit");
  }

  const bytes = await readFile(localPath);
  if (bytes.byteLength !== stat.size) {
    throw new Error("Feishu media file changed while being read");
  }

  return { kind: message.kind, bytes, fileName, byteLength: bytes.byteLength };
}

function normalizeFileName(value: string): string {
  const normalized = value.replace(/[\u0000-\u001F\u007F]+/gu, " ").trim();
  if (!normalized) throw new Error("Feishu media file name must not be empty");
  if (normalized.includes("/") || normalized.includes("\\")) {
    throw new Error("Feishu media file name must not contain path separators");
  }
  const characters = Array.from(normalized);
  return characters.length <= 180 ? normalized : characters.slice(0, 180).join("");
}
