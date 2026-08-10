import type { AgentApprovalHandler, AgentApprovalRequest } from "../core/types.js";
import {
  appConfigApprovalScope,
  extensionCapabilityForAction,
} from "../extensions/extension-approval.js";
import type { ExtensionDiscoverySnapshot } from "./floral-extension-snapshot.js";
import {
  formatAppPermissionReview,
  formatAppReadForTool,
  formatAvailableAppsForTool,
  formatInstalledAppsForTool,
  formatNativeExtensionStatus,
  formatPluginManagementHandoff,
  readAppId,
  readAppIdArray,
  readConfigAppId,
} from "./floral-extension-tools.js";
import { safeDynamicToolToken } from "./floral-tool-response.js";

export interface FloralNativeExtensionToolResult {
  success: boolean;
  text: string;
  mutationPending?: boolean;
}

export class FloralNativeExtensionToolController {
  constructor(private readonly options: {
    writeAppEnabled: (appId: string, enabled: boolean) => Promise<void>;
    listInstalledApps: (cwd: string, threadId: string) => Promise<NonNullable<ExtensionDiscoverySnapshot["installedApps"]>>;
    recordAppInstallHandoff?: ((appId: string) => Promise<{ transactionId: string }>) | undefined;
    recordAppConfigMutation?: ((input: {
      appId: string;
      action: "enable" | "disable";
      changed: boolean;
    }) => Promise<{ transactionId: string }>) | undefined;
  }) {}

  async applyApp(input: {
    id: string;
    action: string;
    cwd: string;
    threadId: string;
    callId: string;
    snapshot: ExtensionDiscoverySnapshot;
    approvalHandler?: AgentApprovalHandler | undefined;
    onApprovalRequested?: ((approval: AgentApprovalRequest) => void) | undefined;
  }): Promise<FloralNativeExtensionToolResult> {
    const appId = readConfigAppId(input.id);
    const action = input.action === "enable" || input.action === "disable"
      ? input.action
      : undefined;
    const installed = appId
      ? input.snapshot.installedApps?.find((app) => app.id === appId && app.source === "installed-runtime")
      : undefined;
    if (!appId || !action || !input.approvalHandler || !installed || !this.options.recordAppConfigMutation) {
      return { success: false, text: "extension_apply=denied\nreason=native-app-config-handler-unavailable" };
    }
    const approval: AgentApprovalRequest = {
      requestId: `app-config-${safeDynamicToolToken(input.callId)}`,
      kind: "extension-management",
      capability: extensionCapabilityForAction(action),
      summary: `FLORAL Agent 请求通过 Codex 原生配置${action === "enable" ? "启用" : "禁用"} App：id=${appId}`,
      source: "floral",
      scope: appConfigApprovalScope(appId, action),
    };
    input.onApprovalRequested?.(approval);
    const decision = await input.approvalHandler(approval).catch(() => "deny" as const);
    if (decision !== "approve") {
      return { success: false, text: "extension_apply=denied\nreason=user-approval" };
    }

    const desiredEnabled = action === "enable";
    try {
      await this.options.writeAppEnabled(appId, desiredEnabled);
      const verified = (await this.options.listInstalledApps(input.cwd, input.threadId))
        .find((app) => app.id === appId && app.source === "installed-runtime");
      if (!verified || verified.enabled !== desiredEnabled) {
        throw new Error("native-app-config-verification-failed");
      }
      const transaction = await this.options.recordAppConfigMutation({
        appId,
        action,
        changed: installed.enabled !== desiredEnabled,
      });
      return {
        success: true,
        mutationPending: true,
        text: [
          `codex_app.${action}=accepted`,
          `app_id=${safeDynamicToolToken(appId)}`,
          `enabled=${String(desiredEnabled)}`,
          "executor=codex-app-server-config/value/write",
          `extension_transaction=${safeDynamicToolToken(transaction.transactionId)}`,
          "verification=pending-fresh-turn",
          "verification_tool=floral_extensions/verify_extension",
          "same_turn_snapshot=stale",
        ].join("\n"),
      };
    } catch {
      await this.options.writeAppEnabled(appId, installed.enabled).catch(() => undefined);
      return { success: false, text: "codex_app.config=rolled-back\nreason=native-write-or-verification-failed" };
    }
  }

  async handleRead(input: {
    tool: string;
    arguments: Record<string, unknown>;
    snapshot: ExtensionDiscoverySnapshot;
  }): Promise<FloralNativeExtensionToolResult | undefined> {
    const { tool, snapshot } = input;
    if (tool === "native_status") {
      if (!snapshot.features) throw new Error("native feature snapshot unavailable");
      return { success: true, text: formatNativeExtensionStatus(snapshot.features) };
    }
    if (tool === "installed_apps") {
      if (!snapshot.installedApps) throw new Error("installed App snapshot unavailable");
      return { success: true, text: formatInstalledAppsForTool(snapshot.installedApps) };
    }
    if (tool === "available_apps") {
      if (!snapshot.availableApps) throw new Error("available App snapshot unavailable");
      return { success: true, text: formatAvailableAppsForTool(snapshot.availableApps) };
    }
    if (tool === "prepare_app_install") return await this.#prepareAppInstall(input.arguments, snapshot);
    if (tool === "app_permission_review") return this.#permissionReview(input.arguments, snapshot);
    if (tool === "prepare_plugin_management") {
      if (!snapshot.features) throw new Error("native feature snapshot unavailable");
      const action = readPluginManagementAction(input.arguments.action);
      const pluginName = readOptionalPluginName(input.arguments.plugin_name);
      if (!action || (input.arguments.plugin_name !== undefined && !pluginName)) {
        return { success: false, text: "plugin_management_handoff=denied\nreason=invalid-arguments" };
      }
      return { success: true, text: formatPluginManagementHandoff(snapshot.features, action, pluginName) };
    }
    if (tool === "read_apps") return this.#readApps(input.arguments, snapshot);
    return undefined;
  }

  async #prepareAppInstall(
    argumentsValue: Record<string, unknown>,
    snapshot: ExtensionDiscoverySnapshot,
  ): Promise<FloralNativeExtensionToolResult> {
    const appId = readAppId(argumentsValue.app_id);
    const selected = appId ? snapshot.availableApps?.find((app) => app.id === appId) : undefined;
    if (!selected || selected.accessible !== true || !selected.installUrl) {
      return { success: false, text: "app_install_handoff=unavailable\nreason=app-not-accessible-or-install-url-missing" };
    }
    const handoff = this.options.recordAppInstallHandoff
      ? await this.options.recordAppInstallHandoff(selected.id).catch(() => undefined)
      : undefined;
    return {
      success: true,
      text: [
        "app_install_handoff=required",
        `app_id=${safeDynamicToolToken(selected.id)}`,
        `app_name=${JSON.stringify(selected.runtimeName ?? selected.id)}`,
        `install_url=${selected.installUrl}`,
        `install_origin=${new URL(selected.installUrl).origin}`,
        "surface=codex-supported-app-install-flow",
        "authentication=user-mediated",
        "oauth_scope_review=required-on-upstream-surface",
        "source_system_authorization=separate",
        ...(handoff ? [`extension_transaction=${safeDynamicToolToken(handoff.transactionId)}`] : []),
        "verification=pending-fresh-turn-after-user-action",
        "verification_tool=floral_extensions/verify_extension",
        "same_turn_verification=forbidden",
        "post_install=start-new-session-and-verify-app-installed",
      ].join("\n"),
    };
  }

  #permissionReview(
    argumentsValue: Record<string, unknown>,
    snapshot: ExtensionDiscoverySnapshot,
  ): FloralNativeExtensionToolResult {
    const appId = readAppId(argumentsValue.app_id);
    if (!appId || !snapshot.appDetails) {
      return { success: false, text: "app_permission_review=denied\nreason=invalid-app-or-snapshot" };
    }
    const installed = snapshot.installedApps?.find((app) => app.id === appId);
    const directory = snapshot.availableApps?.find((app) => app.id === appId);
    const detail = snapshot.appDetails.apps.find((app) => app.id === appId);
    if (!installed && !directory && !detail) {
      return { success: false, text: "app_permission_review=unavailable\nreason=app-not-in-frozen-snapshot" };
    }
    return { success: true, text: formatAppPermissionReview(appId, installed, directory, detail) };
  }

  #readApps(
    argumentsValue: Record<string, unknown>,
    snapshot: ExtensionDiscoverySnapshot,
  ): FloralNativeExtensionToolResult {
    const appIds = readAppIdArray(argumentsValue.app_ids);
    const includeTools = argumentsValue.include_tools;
    if (!appIds || (includeTools !== undefined && typeof includeTools !== "boolean") || !snapshot.appDetails) {
      throw new Error("invalid app read arguments or snapshot unavailable");
    }
    const byId = new Map(snapshot.appDetails.apps.map((app) => [app.id, app] as const));
    const apps = appIds.flatMap((id) => {
      const app = byId.get(id);
      if (!app) return [];
      return [{ ...app, tools: includeTools === false ? [] : app.tools }];
    });
    return {
      success: true,
      text: formatAppReadForTool({ apps, missingAppIds: appIds.filter((id) => !byId.has(id)) }),
    };
  }
}

function readPluginManagementAction(value: unknown): "browse" | "install" | "uninstall" | "enable" | "disable" | undefined {
  return value === "browse" || value === "install" || value === "uninstall" || value === "enable" || value === "disable"
    ? value
    : undefined;
}

function readOptionalPluginName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name.length > 0 && name.length <= 128 && !/[\r\n]/u.test(name) ? name : undefined;
}
