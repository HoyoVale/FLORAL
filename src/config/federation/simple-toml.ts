export interface ParsedTomlDocument {
  value: Record<string, unknown>;
  explicitPaths: Set<string>;
}

/**
 * Parses the deliberately small TOML subset accepted by config/floral.toml.
 *
 * Supported syntax:
 * - dotted table headers such as [codex.sandbox]
 * - bare snake_case keys
 * - double-quoted strings
 * - booleans
 * - finite integers
 * - arrays containing supported scalar values
 *
 * Native upstream configuration is rendered by component adapters in later
 * phases. This parser is intentionally not a general-purpose TOML parser.
 */
export function parseFloralToml(source: string): ParsedTomlDocument {
  const root: Record<string, unknown> = {};
  const explicitPaths = new Set<string>();
  let tablePath: string[] = [];

  for (const [index, originalLine] of source.split(/\r?\n/u).entries()) {
    const lineNumber = index + 1;
    const line = stripComment(originalLine).trim();
    if (line === "") continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      const table = line.slice(1, -1).trim();
      if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(table)) {
        throw new Error(`Invalid FLORAL TOML table at line ${String(lineNumber)}: ${line}`);
      }
      tablePath = table.split(".");
      ensureObjectPath(root, tablePath, lineNumber);
      continue;
    }

    const separator = findUnquotedEquals(line);
    if (separator < 1) {
      throw new Error(`Invalid FLORAL TOML assignment at line ${String(lineNumber)}: ${line}`);
    }

    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z0-9_-]+$/u.test(key)) {
      throw new Error(`Invalid FLORAL TOML key at line ${String(lineNumber)}: ${key}`);
    }

    const rawValue = line.slice(separator + 1).trim();
    if (rawValue === "") {
      throw new Error(`Missing FLORAL TOML value at line ${String(lineNumber)}: ${key}`);
    }

    const target = ensureObjectPath(root, tablePath, lineNumber);
    if (Object.hasOwn(target, key)) {
      throw new Error(`Duplicate FLORAL TOML key at line ${String(lineNumber)}: ${[...tablePath, key].join(".")}`);
    }

    target[key] = parseTomlValue(rawValue, lineNumber);
    explicitPaths.add([...tablePath, key].join("."));
  }

  return { value: root, explicitPaths };
}

function stripComment(line: string): string {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (character === "#" && !inString) return line.slice(0, index);
  }
  if (inString) throw new Error("Unterminated string in FLORAL TOML");
  return line;
}

function findUnquotedEquals(line: string): number {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (character === "=" && !inString) return index;
  }
  return -1;
}

function parseTomlValue(value: string, lineNumber: number): unknown {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "string") throw new Error("not a string");
      return parsed;
    } catch {
      throw new Error(`Invalid FLORAL TOML string at line ${String(lineNumber)}`);
    }
  }

  if (value === "true") return true;
  if (value === "false") return false;

  if (/^-?(?:0|[1-9][0-9]*)$/u.test(value)) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`FLORAL TOML integer is outside the safe range at line ${String(lineNumber)}`);
    }
    return parsed;
  }

  if (/^-?(?:0|[1-9][0-9]*)\.[0-9]+$/u.test(value)) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`FLORAL TOML float is outside the finite range at line ${String(lineNumber)}`);
    }
    return parsed;
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner === "") return [];
    return splitArrayItems(inner, lineNumber).map((item) => {
      const parsed = parseTomlValue(item, lineNumber);
      if (Array.isArray(parsed) || typeof parsed === "object") {
        throw new Error(`Nested FLORAL TOML arrays are not supported at line ${String(lineNumber)}`);
      }
      return parsed;
    });
  }

  throw new Error(`Unsupported FLORAL TOML value at line ${String(lineNumber)}: ${value}`);
}

function splitArrayItems(value: string, lineNumber: number): string[] {
  const items: string[] = [];
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (character === "," && !inString) {
      const item = value.slice(start, index).trim();
      if (item === "") throw new Error(`Empty FLORAL TOML array item at line ${String(lineNumber)}`);
      items.push(item);
      start = index + 1;
    }
  }
  if (inString) throw new Error(`Unterminated FLORAL TOML array string at line ${String(lineNumber)}`);
  const last = value.slice(start).trim();
  if (last === "") throw new Error(`Empty FLORAL TOML array item at line ${String(lineNumber)}`);
  items.push(last);
  return items;
}

function ensureObjectPath(
  root: Record<string, unknown>,
  path: string[],
  lineNumber: number,
): Record<string, unknown> {
  let current = root;
  for (const segment of path) {
    const existing = current[segment];
    if (existing === undefined) {
      const next: Record<string, unknown> = {};
      current[segment] = next;
      current = next;
      continue;
    }
    if (!isPlainRecord(existing)) {
      throw new Error(`FLORAL TOML table conflicts with a value at line ${String(lineNumber)}: ${path.join(".")}`);
    }
    current = existing;
  }
  return current;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
