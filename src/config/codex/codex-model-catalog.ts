import { createHash } from "node:crypto";

export const CODEX_MODEL_CATALOG_PATH_PLACEHOLDER = "__FLORAL_CODEX_MODEL_CATALOG__";
export const CODEX_MODEL_CATALOG_RUNTIME_FILENAME = "model-catalog.json";

const BASE_INSTRUCTIONS = [
  "You are Codex running inside FLORAL with a DeepSeek tool-capable backend.",
  "Use the tools supplied by the runtime when they are needed to inspect or modify the workspace.",
  "For file changes, prefer the apply_patch tool when it is available instead of emulating edits through shell redirection.",
  "When apply_patch is selected, provide one raw patch body delimited by *** Begin Patch and *** End Patch, using *** Add File, *** Update File, or *** Delete File sections as appropriate.",
  "Treat sandbox and approval responses as authoritative: do not retry a denied side effect through a different tool or command.",
  "Never claim that a file, command, or external action succeeded until the corresponding tool result confirms it.",
  "Keep changes scoped to the requested workspace and preserve exact paths and user intent.",
].join(" ");

export function renderCodexModelCatalog(model: string): string {
  const slug = model.trim();
  if (!slug) throw new Error("Codex model catalog requires a non-empty model slug");

  const payload = {
    models: [{
      slug,
      display_name: slug === "deepseek-v4-flash" ? "DeepSeek V4 Flash" : slug,
      description: "FLORAL-managed custom-provider model metadata.",
      default_reasoning_level: "high",
      supported_reasoning_levels: [
        { effort: "high", description: "DeepSeek high reasoning effort" },
        { effort: "xhigh", description: "FLORAL mapping for DeepSeek max reasoning effort" },
      ],
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      availability_nux: null,
      upgrade: null,
      base_instructions: BASE_INSTRUCTIONS,
      supports_reasoning_summary_parameter: false,
      default_reasoning_summary: "none",
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text",
      truncation_policy: { mode: "tokens", limit: 10_000 },
      supports_parallel_tool_calls: false,
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      auto_compact_token_limit: null,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ["text"],
      supports_search_tool: false,
      use_responses_lite: false,
      auto_review_model_override: null,
      tool_mode: null,
      multi_agent_version: null,
    }],
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}


export function materializeCodexModelCatalogPath(
  config: string,
  modelCatalogPath: string,
): string {
  if (!modelCatalogPath.trim()) throw new Error("Codex model catalog path must not be empty");
  return config.replaceAll(
    JSON.stringify(CODEX_MODEL_CATALOG_PATH_PLACEHOLDER),
    JSON.stringify(modelCatalogPath),
  );
}

export function codexModelCatalogFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
