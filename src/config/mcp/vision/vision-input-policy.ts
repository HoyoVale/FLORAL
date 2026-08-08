import {
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

export const DEFAULT_VISION_MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export type TrustedVisionArtifact = {
  absolutePath: string;
  bytes: number;
  extension: string;
};

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function rejectNonFileInputs(input: string): void {
  const normalized = input.trim().toLowerCase();
  if (
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("data:")
  ) {
    throw new Error("Vision input must be a FLORAL artifact path; URL/data inputs are forbidden");
  }
  if (input.length > 4096) {
    throw new Error("Vision artifact path is too long");
  }
}

export function resolveTrustedVisionArtifact(options: {
  artifactPath: string;
  allowedRoot: string;
  maxBytes?: number;
}): TrustedVisionArtifact {
  const artifactPath = options.artifactPath.trim();
  const allowedRoot = options.allowedRoot.trim();
  const maxBytes = options.maxBytes ?? DEFAULT_VISION_MAX_BYTES;

  if (!artifactPath) throw new Error("Vision artifact path is required");
  if (!allowedRoot) throw new Error("FLORAL vision allowed root is required");
  rejectNonFileInputs(artifactPath);

  const realRoot = realpathSync(resolve(allowedRoot));
  const requestedPath = isAbsolute(artifactPath)
    ? resolve(artifactPath)
    : resolve(realRoot, artifactPath);

  const inputLstat = lstatSync(requestedPath);
  if (inputLstat.isSymbolicLink()) {
    throw new Error("Vision artifact symlinks are forbidden");
  }

  const realArtifact = realpathSync(requestedPath);
  if (!isInside(realRoot, realArtifact)) {
    throw new Error("Vision artifact is outside the FLORAL screenshot root");
  }

  const stat = statSync(realArtifact);
  if (!stat.isFile()) throw new Error("Vision artifact must be a regular file");
  if (stat.nlink > 1) throw new Error("Vision artifact hardlinks are forbidden");
  if (stat.size <= 0) throw new Error("Vision artifact is empty");
  if (stat.size > maxBytes) {
    throw new Error(`Vision artifact exceeds ${maxBytes} bytes`);
  }

  const extension = extname(realArtifact).toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported vision artifact extension: ${extension || "(none)"}`);
  }

  return {
    absolutePath: realArtifact,
    bytes: stat.size,
    extension,
  };
}
