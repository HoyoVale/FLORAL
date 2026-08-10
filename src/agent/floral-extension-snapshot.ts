import type {
  AgentAppReadResult,
  AgentAppSummary,
  AgentMcpServerSummary,
  AgentNativeFeatureSummary,
} from "../core/contracts.js";

export interface ExtensionDiscoverySnapshot {
  features?: AgentNativeFeatureSummary[] | undefined;
  installedApps?: AgentAppSummary[] | undefined;
  availableApps?: AgentAppSummary[] | undefined;
  appDetails?: AgentAppReadResult | undefined;
  mcpServers?: AgentMcpServerSummary[] | undefined;
  errors: string[];
}

export interface ExtensionSnapshotSources {
  listFeatures: (cwd: string) => Promise<AgentNativeFeatureSummary[]>;
  listInstalledApps: (cwd: string, threadId: string) => Promise<AgentAppSummary[]>;
  listAvailableApps: (cwd: string, threadId: string) => Promise<AgentAppSummary[]>;
  listMcpServers: (cwd: string, threadId: string) => Promise<AgentMcpServerSummary[]>;
  readApps: (cwd: string, appIds: string[]) => Promise<AgentAppReadResult>;
}

export class FloralExtensionSnapshotStore {
  readonly #snapshots = new Map<string, ExtensionDiscoverySnapshot>();

  constructor(private readonly sources: ExtensionSnapshotSources) {}

  get(threadId: string): ExtensionDiscoverySnapshot | undefined {
    return this.#snapshots.get(threadId);
  }

  clearThread(threadId: string): void {
    this.#snapshots.delete(threadId);
  }

  clear(): void {
    this.#snapshots.clear();
  }

  async capture(threadId: string, cwd: string): Promise<void> {
    const snapshot: ExtensionDiscoverySnapshot = { errors: [] };
    const [featureResult, installedResult, availableResult, mcpResult] = await Promise.allSettled([
      this.sources.listFeatures(cwd),
      this.sources.listInstalledApps(cwd, threadId),
      this.sources.listAvailableApps(cwd, threadId),
      this.sources.listMcpServers(cwd, threadId),
    ]);
    if (featureResult.status === "fulfilled") snapshot.features = featureResult.value;
    else snapshot.errors.push("experimentalFeature/list");
    if (installedResult.status === "fulfilled") {
      snapshot.installedApps = installedResult.value;
    } else snapshot.errors.push("app/installed");
    if (availableResult.status === "fulfilled") snapshot.availableApps = availableResult.value;
    else snapshot.errors.push("app/list");
    const appIds = [...new Set([
      ...(snapshot.installedApps ?? []).map((app) => app.id),
      ...(snapshot.availableApps ?? []).map((app) => app.id),
    ])].slice(0, 100);
    if (appIds.length > 0) {
      try {
        snapshot.appDetails = await this.sources.readApps(cwd, appIds);
      } catch {
        snapshot.errors.push("app/read");
      }
    } else snapshot.appDetails = { apps: [], missingAppIds: [] };
    if (mcpResult.status === "fulfilled") snapshot.mcpServers = mcpResult.value;
    else snapshot.errors.push("mcpServerStatus/list");

    this.#snapshots.set(threadId, snapshot);
    process.stderr.write(
      snapshot.errors.length > 0
        ? `agent.stack.extensions.snapshot=partial:${snapshot.errors.join(",")}\n`
        : "agent.stack.extensions.snapshot=ok\n",
    );
  }
}
