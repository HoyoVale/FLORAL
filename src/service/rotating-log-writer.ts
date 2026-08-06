import { chmod, mkdir, open, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

export class RotatingLogWriter {
  readonly #path: string;
  readonly #maxBytes: number;
  readonly #backups: number;
  #handle: FileHandle | undefined;
  #size = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string, maxBytes: number, backups: number) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1024) {
      throw new Error("Log maxBytes must be an integer of at least 1024");
    }
    if (!Number.isInteger(backups) || backups < 1 || backups > 20) {
      throw new Error("Log backups must be an integer between 1 and 20");
    }
    this.#path = path;
    this.#maxBytes = maxBytes;
    this.#backups = backups;
  }

  write(chunk: Uint8Array | string): Promise<void> {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    this.#tail = this.#tail.then(() => this.#writeOnce(bytes));
    return this.#tail;
  }

  async close(): Promise<void> {
    await this.#tail;
    await this.#handle?.close();
    this.#handle = undefined;
  }

  async #writeOnce(bytes: Buffer): Promise<void> {
    await this.#ensureOpen();
    if (this.#size > 0 && this.#size + bytes.length > this.#maxBytes) {
      await this.#rotate();
      await this.#ensureOpen();
    }
    await this.#handle!.write(bytes);
    this.#size += bytes.length;
  }

  async #ensureOpen(): Promise<void> {
    if (this.#handle) return;
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    this.#handle = await open(this.#path, "a", 0o600);
    await chmod(this.#path, 0o600);
    this.#size = await stat(this.#path).then((value) => value.size, () => 0);
  }

  async #rotate(): Promise<void> {
    await this.#handle?.close();
    this.#handle = undefined;

    await rm(`${this.#path}.${this.#backups}`, { force: true });
    for (let index = this.#backups - 1; index >= 1; index -= 1) {
      await renameIfPresent(`${this.#path}.${index}`, `${this.#path}.${index + 1}`);
    }
    await renameIfPresent(this.#path, `${this.#path}.1`);
    this.#size = 0;
  }
}

async function renameIfPresent(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
