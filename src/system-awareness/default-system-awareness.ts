import { resolve } from "node:path";
import type { AgentRuntime } from "../core/contracts.js";
import type { AppEnv } from "../config/env.js";
import type { ResolvedConfigurationAuthority } from "../config/federation/config-authority.js";
import { createDefaultSystemDefinitionRegistry } from "./default-system-definitions.js";
import { SystemSnapshotBuilder } from "./system-snapshot-builder.js";
import { SystemAwarenessReader } from "./system-read-interface.js";
import type { SystemObserver } from "./system-types.js";
import { CodexRuntimeSystemObserver } from "./observers/codex-runtime-system-observer.js";
import { ConfigurationSystemObserver } from "./observers/configuration-system-observer.js";
import { ExternalExtensionSystemObserver } from "./observers/external-extension-system-observer.js";
import { ExecutionContextSystemObserver } from "./observers/execution-context-system-observer.js";
import { ServiceStateSystemObserver } from "./observers/service-state-system-observer.js";
import { MaintenanceSystemObserver } from "./observers/maintenance-system-observer.js";
import { ExtensionControlSystemObserver } from "./observers/extension-control-system-observer.js";
import { resolveSystemMaintenanceDirectory } from "../system-maintenance/system-maintenance.js";
import { resolveExtensionControlDirectory } from "../extensions/extension-control.js";

export interface DefaultSystemAwarenessOptions {
  repositoryRoot: string;
  authority: ResolvedConfigurationAuthority;
  env: AppEnv;
  runtime?: AgentRuntime | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  now?: (() => Date) | undefined;
}

export function createDefaultSystemObservers(
  options: DefaultSystemAwarenessOptions,
): SystemObserver[] {
  const now = options.now;
  const mcpComponentByServerId: Record<string, string> = {
    [options.authority.effective.mcp.search.id]: "mcp.floral_search",
    [options.authority.effective.mcp.vision.id]: "mcp.floral_vision",
    [options.authority.effective.mcp.macos.id]: "mcp.floral_peekaboo",
  };
  const observers: SystemObserver[] = [
    new ExecutionContextSystemObserver({
      ...(now ? { now } : {}),
    }),
    new ConfigurationSystemObserver({
      authority: options.authority,
      env: options.env,
      ...(now ? { now } : {}),
    }),
    new ServiceStateSystemObserver({
      statePath: resolve(options.repositoryRoot, options.env.FLORAL_SERVICE_STATE_PATH),
      ...(now ? { now } : {}),
    }),
    new ExternalExtensionSystemObserver({
      repositoryRoot: options.repositoryRoot,
      dataDir: options.authority.effective.floral.data_dir,
      environment: options.environment ?? process.env,
      ...(now ? { now } : {}),
    }),
    new ExtensionControlSystemObserver({
      directory: resolveExtensionControlDirectory(
        options.repositoryRoot,
        options.authority.effective.floral.data_dir,
      ),
      ...(now ? { now } : {}),
    }),
    new MaintenanceSystemObserver({
      directory: resolveSystemMaintenanceDirectory(
        options.repositoryRoot,
        options.authority.effective.floral.data_dir,
      ),
      autonomy: {
        ceiling: options.env.FLORAL_MAINTENANCE_MODE_CEILING,
        allowedActions: ["floral.service.restart"],
        maxAutomaticActionsPerHour: options.env.FLORAL_MAINTENANCE_MAX_ACTIONS_PER_HOUR,
        cooldownMs: options.env.FLORAL_MAINTENANCE_COOLDOWN_MS,
        failureThreshold: options.env.FLORAL_MAINTENANCE_FAILURE_THRESHOLD,
        selfHealIntervalMs: options.env.FLORAL_MAINTENANCE_SELF_HEAL_INTERVAL_MS,
      },
      ...(now ? { now } : {}),
    }),
  ];
  if (options.runtime) {
    observers.push(new CodexRuntimeSystemObserver({
      runtime: options.runtime,
      mcpComponentByServerId,
      ...(now ? { now } : {}),
    }));
  }
  return observers;
}

export function createDefaultSystemSnapshotBuilder(
  options: DefaultSystemAwarenessOptions,
): SystemSnapshotBuilder {
  const registry = createDefaultSystemDefinitionRegistry();
  return new SystemSnapshotBuilder({
    registry,
    observers: createDefaultSystemObservers(options),
    ...(options.now ? { now: options.now } : {}),
  });
}

export function createDefaultSystemAwarenessReader(
  options: DefaultSystemAwarenessOptions,
): SystemAwarenessReader {
  const registry = createDefaultSystemDefinitionRegistry();
  const builder = new SystemSnapshotBuilder({
    registry,
    observers: createDefaultSystemObservers(options),
    ...(options.now ? { now: options.now } : {}),
  });
  return new SystemAwarenessReader(registry, builder);
}
