export interface FloralDynamicToolResponse {
  contentItems: Array<{ type: "inputText"; text: string }>;
  success: boolean;
}

export function dynamicToolResponse(
  success: boolean,
  text: string,
): FloralDynamicToolResponse {
  return {
    success,
    contentItems: [{ type: "inputText", text }],
  };
}

export function boundedDynamicToolText(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .trim();
  return normalized.length <= 12_000
    ? normalized
    : `${normalized.slice(0, 11_980)}\ntruncated=true`;
}

export function safeDynamicToolToken(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized.slice(0, 96) || "unknown";
}
