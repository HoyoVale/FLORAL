export interface QqTextChunkOptions {
  maxCharacters: number;
  maxChunks: number;
  truncationSuffix?: string | undefined;
}

const DEFAULT_TRUNCATION_SUFFIX = "\n\n[回复过长，后续内容已截断]";
const DEFAULT_SOFT_CHUNK_CHARACTERS = 1_000;

export function splitQqText(
  text: string,
  options: QqTextChunkOptions,
): string[] {
  const maxCharacters = assertPositiveInteger(
    options.maxCharacters,
    "QQ text chunk size",
  );
  const maxChunks = assertPositiveInteger(
    options.maxChunks,
    "QQ maximum reply chunks",
  );
  const suffix = options.truncationSuffix ?? DEFAULT_TRUNCATION_SUFFIX;
  const normalized = text.replace(/\r\n?/g, "\n").trim();

  if (!normalized) return ["（空回复）"];

  const source = Array.from(normalized);
  const chunks: string[] = [];
  const preferredCharacters = preferredChunkCharacters(
    source.length,
    maxCharacters,
    maxChunks,
  );
  let offset = 0;

  while (offset < source.length && chunks.length < maxChunks) {
    const remainingSlots = maxChunks - chunks.length;
    const remaining = source.length - offset;

    if (
      remaining <= preferredCharacters
      || (remainingSlots === 1 && remaining <= maxCharacters)
    ) {
      chunks.push(source.slice(offset).join(""));
      break;
    }

    if (remainingSlots === 1) {
      const suffixCharacters = Array.from(suffix);
      const bodyLength = Math.max(1, maxCharacters - suffixCharacters.length);
      chunks.push(
        source.slice(offset, offset + bodyLength).join("")
        + suffixCharacters.slice(0, maxCharacters - bodyLength).join(""),
      );
      break;
    }

    const remainingCapacity = remainingSlots * maxCharacters;
    const minimumForThisChunk = remaining <= remainingCapacity
      ? Math.max(1, remaining - ((remainingSlots - 1) * maxCharacters))
      : 1;
    const tentativeEnd = Math.min(
      source.length,
      offset + Math.min(
        maxCharacters,
        Math.max(preferredCharacters, minimumForThisChunk),
      ),
    );
    const breakAt = findNaturalBreak(
      source,
      offset,
      tentativeEnd,
      minimumForThisChunk,
    );
    chunks.push(source.slice(offset, breakAt).join("").trimEnd());
    offset = skipWhitespace(source, breakAt);
  }

  return chunks;
}

function findNaturalBreak(
  characters: string[],
  start: number,
  end: number,
  minimumLength: number,
): number {
  const minimum = Math.max(
    start + minimumLength,
    start + Math.floor((end - start) * 0.65),
  );

  for (let index = end; index > minimum; index -= 1) {
    const current = characters[index - 1];
    const previous = characters[index - 2];
    if (current === "\n" && previous === "\n") return index;
  }

  for (let index = end; index > minimum; index -= 1) {
    const previous = characters[index - 1];
    if (previous === "\n") return index;
  }

  for (let index = end; index > minimum; index -= 1) {
    const previous = characters[index - 1];
    if (previous && /[。！？.!?]/u.test(previous)) return index;
  }

  for (let index = end; index > minimum; index -= 1) {
    const previous = characters[index - 1];
    if (previous && /\s/u.test(previous)) return index;
  }

  return end;
}

function preferredChunkCharacters(
  totalCharacters: number,
  maxCharacters: number,
  maxChunks: number,
): number {
  if (totalCharacters <= DEFAULT_SOFT_CHUNK_CHARACTERS) {
    return maxCharacters;
  }
  const desiredChunks = Math.min(
    maxChunks,
    Math.ceil(totalCharacters / DEFAULT_SOFT_CHUNK_CHARACTERS),
  );
  return Math.min(
    maxCharacters,
    Math.max(1, Math.ceil(totalCharacters / desiredChunks)),
  );
}

function skipWhitespace(characters: string[], offset: number): number {
  let index = offset;
  while (index < characters.length && /\s/u.test(characters[index] ?? "")) {
    index += 1;
  }
  return index;
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}
