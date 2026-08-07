/**
 * QQ private-chat currently uses the SDK plain-text send path. Keep the agent's
 * Markdown semantics readable without leaking raw Markdown control characters
 * into the chat bubble. Native QQ Markdown can be layered above this formatter
 * later; this function remains the deterministic fallback.
 */
export function presentQqText(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "（空回复）";

  const lines = normalized.split("\n");
  const output: string[] = [];
  let inFence = false;

  for (const sourceLine of lines) {
    const fence = /^\s*```(?:[^`]*)?\s*$/u.test(sourceLine);
    if (fence) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      output.push(sourceLine);
      continue;
    }

    const tableLine = presentTableLine(sourceLine);
    if (tableLine === undefined) continue;

    let line = tableLine
      .replace(/^\s{0,3}#{1,6}\s+(.+)$/u, "$1")
      .replace(/^\s*>\s?/u, "› ")
      .replace(/^\s*[-+*]\s+/u, "• ")
      .replace(/^\s*(\d+)[.)]\s+/u, "$1. ")
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/gu, (_match, alt: string, url: string) => {
        const label = alt.trim() || "图片";
        return `${label} (${url.trim()})`;
      })
      .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, (_match, label: string, url: string) =>
        `${label.trim()} (${url.trim()})`
      )
      .replace(/`([^`\n]+)`/gu, "$1")
      .replace(/\*\*([^*\n]+)\*\*/gu, "$1")
      .replace(/~~([^~\n]+)~~/gu, "$1")
      .replace(/\\([\\`*_{}\[\]()#+.!>-])/gu, "$1")
      .trimEnd();

    if (/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/u.test(line)) {
      line = "";
    }
    output.push(line);
  }

  return collapseBlankLines(output.join("\n"));
}

function presentTableLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return line;

  const cells = trimmed
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());

  if (cells.length < 2) return line;
  if (cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) return undefined;
  return cells.filter(Boolean).join(" · ");
}

function collapseBlankLines(text: string): string {
  return text
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
