import {
  DEFAULT_MIMO_VISION_BASE_URL,
  DEFAULT_MIMO_VISION_MODEL,
  FLORAL_VISION_SERVER_NAME,
  FLORAL_VISION_SERVER_VERSION,
  FLORAL_VISION_TOOLS,
} from "../src/config/mcp/vision/floral-vision-contract.js";

const allowedRoot = process.env.FLORAL_VISION_ALLOWED_ROOT?.trim();
const keyPresent = Boolean(process.env.MIMO_API_KEY?.trim());
const baseUrl = process.env.MIMO_BASE_URL?.trim() || DEFAULT_MIMO_VISION_BASE_URL;
const model = process.env.MIMO_VISION_MODEL?.trim() || DEFAULT_MIMO_VISION_MODEL;

console.log(`vision.server=${FLORAL_VISION_SERVER_NAME}`);
console.log(`vision.version=${FLORAL_VISION_SERVER_VERSION}`);
console.log(`vision.tools=${FLORAL_VISION_TOOLS.join(",")}`);
console.log(`vision.allowed_root=${allowedRoot ? "present" : "missing"}`);
console.log(`vision.secret.mimo_api_key=${keyPresent ? "present" : "missing"}`);
console.log(`vision.base_url=${baseUrl}`);
console.log(`vision.model=${model}`);

const url = new URL(baseUrl);
if (url.protocol !== "https:" || !(url.hostname === "xiaomimimo.com" || url.hostname.endsWith(".xiaomimimo.com"))) {
  throw new Error("MiMo base URL is not an official HTTPS xiaomimimo.com endpoint");
}
if (!allowedRoot) {
  throw new Error("FLORAL_VISION_ALLOWED_ROOT is required for the production probe");
}
if (!keyPresent) {
  throw new Error("MIMO_API_KEY is required for the production probe");
}
console.log("vision.probe=ok");
