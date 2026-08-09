import {
  CURATED_EXTERNAL_MCP,
  EXTERNAL_MCP_REGISTRY_VERSION,
  externalMcpRegistryFingerprint,
  readExternalMcpRegistry,
  resolveExternalMcpRegistryPaths,
  writeExternalMcpRegistry,
  type ExternalMcpCatalogId,
  type ExternalMcpRegistry,
} from "./external-mcp-registry.js";

export type ExternalMcpMutationAction =
  | "install"
  | "enable"
  | "disable"
  | "remove";

export interface ExternalMcpMutationRequest {
  action: ExternalMcpMutationAction;
  id: ExternalMcpCatalogId;
}

export interface ExternalMcpManagementResult {
  changed: boolean;
  message: string;
  registry: ExternalMcpRegistry;
}

export interface ExternalMcpCatalogStatus {
  id: ExternalMcpCatalogId;
  serverId: string;
  displayName: string;
  installed: boolean;
  enabled: boolean;
  strictReadOnly: boolean;
  auth: "none" | "present" | "missing";
  authEnvVar?: string | undefined;
  transport: "http" | "stdio";
  supplyChain: string;
}

export class ExternalMcpHostManager {
  readonly #paths;

  constructor(
    repositoryRoot: string,
    dataDir: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.#paths = resolveExternalMcpRegistryPaths(repositoryRoot, dataDir);
  }

  async readRegistry(): Promise<ExternalMcpRegistry> {
    return await readExternalMcpRegistry(this.#paths);
  }

  async listCatalog(): Promise<ExternalMcpCatalogStatus[]> {
    const registry = await this.readRegistry();
    const byId = new Map(registry.packages.map((entry) => [entry.id, entry] as const));
    return Object.values(CURATED_EXTERNAL_MCP).map((catalog) => {
      const installed = byId.get(catalog.id);
      const auth = catalog.authentication === "none"
        ? "none" as const
        : this.environment[catalog.authEnvVar ?? ""]?.trim()
          ? "present" as const
          : "missing" as const;
      return {
        id: catalog.id,
        serverId: catalog.serverId,
        displayName: catalog.displayName,
        installed: Boolean(installed),
        enabled: installed?.enabled ?? false,
        strictReadOnly: catalog.strictReadOnly,
        auth,
        ...(catalog.authEnvVar ? { authEnvVar: catalog.authEnvVar } : {}),
        transport: catalog.transport.type,
        supplyChain: catalog.supplyChain,
      };
    });
  }

  async catalogText(): Promise<string> {
    const catalog = await this.listCatalog();
    return [
      `external_mcp_catalog.count=${String(catalog.length)}`,
      ...catalog.map((entry) => [
        `id=${entry.id}`,
        `server=${entry.serverId}`,
        `installed=${String(entry.installed)}`,
        `enabled=${String(entry.enabled)}`,
        `transport=${entry.transport}`,
        `readOnly=${String(entry.strictReadOnly)}`,
        `auth=${entry.auth}`,
        ...(entry.authEnvVar ? [`authEnv=${entry.authEnvVar}`] : []),
        `source=${entry.supplyChain}`,
      ].join(" ")),
    ].join("\n");
  }

  async mutate(
    request: ExternalMcpMutationRequest,
  ): Promise<ExternalMcpManagementResult> {
    const registry = await this.readRegistry();
    const existing = registry.packages.find((entry) => entry.id === request.id);
    const now = new Date().toISOString();
    let changed = false;
    let packages = [...registry.packages];

    switch (request.action) {
      case "install":
        if (!existing) {
          packages.push({
            id: request.id,
            enabled: true,
            installedAt: now,
            updatedAt: now,
          });
          changed = true;
        }
        break;
      case "enable":
        if (!existing) throw new Error(`${request.id} is not installed`);
        if (!existing.enabled) {
          packages = packages.map((entry) =>
            entry.id === request.id
              ? { ...entry, enabled: true, updatedAt: now }
              : entry
          );
          changed = true;
        }
        break;
      case "disable":
        if (!existing) throw new Error(`${request.id} is not installed`);
        if (existing.enabled) {
          packages = packages.map((entry) =>
            entry.id === request.id
              ? { ...entry, enabled: false, updatedAt: now }
              : entry
          );
          changed = true;
        }
        break;
      case "remove":
        if (!existing) throw new Error(`${request.id} is not installed`);
        packages = packages.filter((entry) => entry.id !== request.id);
        changed = true;
        break;
    }

    const next: ExternalMcpRegistry = {
      version: EXTERNAL_MCP_REGISTRY_VERSION,
      packages: packages.sort((a, b) => a.id.localeCompare(b.id)),
    };
    if (changed) await writeExternalMcpRegistry(this.#paths, next);
    const effective = changed ? next : registry;
    const catalog = CURATED_EXTERNAL_MCP[request.id];
    const auth = catalog.authentication === "none"
      ? "none" as const
      : this.environment[catalog.authEnvVar ?? ""]?.trim()
        ? "present" as const
        : "missing" as const;
    return {
      changed,
      registry: effective,
      message: [
        `external_mcp.${request.action}=${changed ? "ok" : "unchanged"}`,
        `id=${request.id}`,
        `server=${catalog.serverId}`,
        `fingerprint=${externalMcpRegistryFingerprint(effective)}`,
        `auth=${auth}`,
        ...(auth === "missing" && catalog.authEnvVar
          ? [
              `required_secret=${catalog.authEnvVar}`,
              "service_restart_required_after_secret=true",
            ]
          : []),
        "reload=scheduled",
        "restart_required=false",
      ].join("\n"),
    };
  }
}
