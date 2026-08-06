const OFFICIAL_IMAGE_PATTERN = /^docker\.io\/searxng\/searxng@sha256:[a-f0-9]{64}$/;

export function parsePinnedSearxngImage(composeText: string): string {
  const matches = [...composeText.matchAll(/^\s*image:\s*([^\s#]+)\s*$/gm)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one SearXNG image entry, found ${matches.length}`);
  }

  const image = matches[0]?.[1];
  if (!image || !OFFICIAL_IMAGE_PATTERN.test(image)) {
    throw new Error(
      "SearXNG image must use docker.io/searxng/searxng pinned by sha256 digest",
    );
  }
  return image;
}
