import { lstat } from "node:fs/promises";
import type { IncomingMessage } from "../core/types.js";

export async function assertDurableAttachmentsAvailable(
  message: IncomingMessage,
): Promise<void> {
  for (const attachment of message.attachments ?? []) {
    const localPath = attachment.localPath?.trim();
    if (!localPath) throw new DurableAttachmentUnavailableError();
    const metadata = await lstat(localPath).catch(() => undefined);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) {
      throw new DurableAttachmentUnavailableError();
    }
    if (
      attachment.byteLength !== undefined
      && metadata.size !== attachment.byteLength
    ) {
      throw new DurableAttachmentUnavailableError();
    }
  }
}

export class DurableAttachmentUnavailableError extends Error {
  override readonly name = "DurableAttachmentUnavailableError";

  constructor() {
    super("A durable queued attachment is missing or has changed");
  }
}
