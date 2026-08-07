const FEISHU_POST_SAFE_BYTES = 28_000;

export interface FeishuRichTextPayload {
  zh_cn: {
    content: Array<Array<{
      tag: "md";
      text: string;
    }>>;
  };
}

export function hasFeishuRenderableMarkdown(value: string): boolean {
  const normalized = value.replace(/\r\n?/gu, "\n");
  if (/```|~~~|(^|\n)\s{0,3}(?:#{1,6}\s|>\s|[-+*]\s|\d+[.)]\s)/mu.test(normalized)) {
    return true;
  }
  if (/(?:\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^)]+\))/u.test(normalized)) {
    return true;
  }
  return /(^|\n)\s*\|.+\|\s*\n\s*\|?\s*:?-{3,}/mu.test(normalized);
}

export function sanitizeFeishuMarkdown(value: string): string {
  const normalized = normalizeText(value);
  return normalized
    .replace(/<at(?=\s|>)/giu, "\\<at")
    .replace(/<\/at>/giu, "\\</at>")
    .replace(/!\[/gu, "\\![");
}

export function buildFeishuMarkdownPost(value: string): FeishuRichTextPayload {
  return {
    zh_cn: {
      content: [[{
        tag: "md",
        text: sanitizeFeishuMarkdown(value),
      }]],
    },
  };
}

export function serializeFeishuMarkdownPostIfSafe(
  value: string,
  maxBytes = FEISHU_POST_SAFE_BYTES,
): string | undefined {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Feishu post maximum bytes must be a positive integer");
  }
  const serialized = JSON.stringify(buildFeishuMarkdownPost(value));
  return Buffer.byteLength(serialized, "utf8") <= maxBytes ? serialized : undefined;
}

function normalizeText(value: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  return normalized || "（空回复）";
}
