import type { AppEnv } from "../../config/env.js";
import type { ResolvedConfigurationAuthority } from "../../config/federation/config-authority.js";
import {
  buildLegacyQqRuntimeOptionsContract,
  buildQqRuntimeOptionsContract,
  createQqTransportOptionsFromContract,
  resolveQqRuntimeCredentials,
  type QqRuntimeOptionsContract,
} from "../../config/qq/qq-runtime-options.js";
import {
  createQqRuntimeAdoptionReport,
  removeQqRuntimeAdoptionReport,
  writeQqRuntimeAdoptionReport,
  type QqRuntimeAdoptionReport,
} from "../../config/adoption/qq-runtime-options-adoption.js";
import {
  supportsConversationActivity,
  type ChatTransport,
  type ConversationActivityState,
  type ConversationActivityTransport,
} from "../../core/contracts.js";
import type { IncomingMessage, OutgoingMessage } from "../../core/types.js";
import { assertInstalledQqSdkVersion } from "./qq-sdk-contract.js";
import { QqTransport, type QqTransportOptions } from "./qq-transport.js";

export interface QqRuntimeAdoptionDependencies {
  createTransport?: ((options: QqTransportOptions) => ChatTransport) | undefined;
  resolveInstalledSdkVersion?: ((expectedVersion: string) => Promise<string>) | undefined;
  clearReport?: (() => Promise<void>) | undefined;
  recordReport?: ((report: QqRuntimeAdoptionReport) => Promise<string>) | undefined;
}

export class QqRuntimeAdoptionTransport
  implements ChatTransport, ConversationActivityTransport
{
  readonly name = "qq-open-platform";
  #active: ChatTransport | undefined;
  #starting: Promise<void> | undefined;
  #stopped = false;

  constructor(
    private readonly repositoryRoot: string,
    private readonly authority: ResolvedConfigurationAuthority,
    private readonly env: AppEnv,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly dependencies: QqRuntimeAdoptionDependencies = {},
  ) {}

  async start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    if (this.#active) return;
    if (this.#stopped) throw new Error("QQ runtime adoption transport cannot restart after stop");
    if (this.#starting) return await this.#starting;
    this.#starting = this.#startOnce(onMessage);
    try {
      await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.#active) throw new Error("QQ runtime adoption transport is not ready");
    await this.#active.send(message);
  }

  async setConversationActivity(
    conversationId: string,
    state: ConversationActivityState,
  ): Promise<void> {
    const active = this.#active;
    if (!active || !supportsConversationActivity(active)) return;
    await active.setConversationActivity(conversationId, state);
  }

  // Phase 5 closure: keep native Inline Keyboard support in QqTransport and the
  // direct probe, but do not advertise it through the production adoption wrapper
  // until QQ grants the message-template / Inline Keyboard capability. Gateway's
  // structural capability detection therefore selects the stable text approval path.
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const active = this.#active;
    this.#active = undefined;
    await active?.stop();
  }

  async #startOnce(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    const unified = buildQqRuntimeOptionsContract(this.authority.effective);
    const legacy = buildLegacyQqRuntimeOptionsContract(this.env);
    const credentials = resolveQqRuntimeCredentials(this.authority, this.environment);
    const mode = this.authority.effective.runtime.adoption.qq_sdk.mode;

    if (mode === "legacy") {
      await this.#clearReport(true);
      const transport = this.#createTransport(createQqTransportOptionsFromContract({
        contract: legacy,
        credentials,
        repositoryRoot: this.repositoryRoot,
      }));
      await transport.start(onMessage);
      this.#active = transport;
      process.stderr.write("qq.runtime_options.mode=legacy\n");
      return;
    }

    await this.#clearReport(false);
    let installedSdkVersion = "unavailable";
    let unifiedTransport: ChatTransport | undefined;
    try {
      installedSdkVersion = await (this.dependencies.resolveInstalledSdkVersion?.(
        unified.expectedVersion,
      ) ?? assertInstalledQqSdkVersion(unified.expectedVersion));
      unifiedTransport = this.#createTransport(createQqTransportOptionsFromContract({
        contract: unified,
        credentials,
        repositoryRoot: this.repositoryRoot,
      }));
      await unifiedTransport.start(onMessage);
      await this.#recordReport(createQqRuntimeAdoptionReport({
        status: "active",
        activeOptions: "unified",
        effectiveFingerprint: this.authority.effectiveFingerprint,
        unified,
        legacy,
        installedSdkVersion,
        fallbackUsed: false,
        reasonCode: "unified-ready",
      }));
      this.#active = unifiedTransport;
      process.stderr.write(`qq.runtime_options.fingerprint=${unified.runtimeFingerprint}\n`);
      process.stderr.write("qq.runtime_options=active\n");
      return;
    } catch (unifiedError) {
      await unifiedTransport?.stop().catch(() => undefined);
      process.stderr.write(`qq.runtime_options.rollback=legacy:${errorName(unifiedError)}\n`);
      const legacyTransport = this.#createTransport(createQqTransportOptionsFromContract({
        contract: legacy,
        credentials,
        repositoryRoot: this.repositoryRoot,
      }));
      try {
        await legacyTransport.start(onMessage);
        await this.#recordReport(createQqRuntimeAdoptionReport({
          status: "rolled-back",
          activeOptions: "legacy",
          effectiveFingerprint: this.authority.effectiveFingerprint,
          unified,
          legacy,
          installedSdkVersion,
          fallbackUsed: true,
          reasonCode: "unified-start-failed-legacy-recovered",
          startupError: unifiedError,
        })).catch((reportError) => {
          process.stderr.write(`qq.runtime_options.report=error:${errorName(reportError)}\n`);
        });
        this.#active = legacyTransport;
        process.stderr.write("qq.runtime_options=rolled-back\n");
        return;
      } catch (fallbackError) {
        await legacyTransport.stop().catch(() => undefined);
        await this.#recordReport(createQqRuntimeAdoptionReport({
          status: "failed",
          activeOptions: "none",
          effectiveFingerprint: this.authority.effectiveFingerprint,
          unified,
          legacy,
          installedSdkVersion,
          fallbackUsed: true,
          reasonCode: "unified-and-legacy-start-failed",
          startupError: unifiedError,
          fallbackError,
        })).catch(() => undefined);
        throw new AggregateError(
          [unifiedError, fallbackError],
          "QQ unified runtime options and legacy fallback both failed",
        );
      }
    }
  }

  #createTransport(options: QqTransportOptions): ChatTransport {
    return this.dependencies.createTransport?.(options) ?? new QqTransport(options);
  }

  async #clearReport(ignoreErrors: boolean): Promise<void> {
    const operation = this.dependencies.clearReport?.()
      ?? removeQqRuntimeAdoptionReport(this.repositoryRoot);
    if (ignoreErrors) {
      await operation.catch(() => undefined);
      return;
    }
    await operation;
  }

  async #recordReport(report: QqRuntimeAdoptionReport): Promise<void> {
    const path = await (this.dependencies.recordReport?.(report)
      ?? writeQqRuntimeAdoptionReport(this.repositoryRoot, report));
    process.stderr.write(`qq.runtime_options.report_fingerprint=${report.reportFingerprint}\n`);
    process.stderr.write(`qq.runtime_options.report_path=${path}\n`);
  }
}

export function createUnifiedQqTransportForProbe(input: {
  repositoryRoot: string;
  authority: ResolvedConfigurationAuthority;
  environment: NodeJS.ProcessEnv;
}): QqTransport {
  const contract = buildQqRuntimeOptionsContract(input.authority.effective);
  const credentials = resolveQqRuntimeCredentials(input.authority, input.environment);
  return new QqTransport(createQqTransportOptionsFromContract({
    contract,
    credentials,
    repositoryRoot: input.repositoryRoot,
  }));
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name.trim() ? error.name : "Error";
}
