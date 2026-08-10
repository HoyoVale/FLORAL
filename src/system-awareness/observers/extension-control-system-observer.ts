import {
  readLatestExtensionControlTransaction,
} from "../../extensions/extension-control.js";
import type {
  SystemEvidence,
  SystemObservationContext,
  SystemObserver,
} from "../system-types.js";
import { evidence } from "./observer-utils.js";

export interface ExtensionControlSystemObserverOptions {
  directory: string;
  now?: (() => Date) | undefined;
}

export class ExtensionControlSystemObserver implements SystemObserver {
  readonly id = "extension-control";
  readonly componentIds = ["floral.extension_control"] as const;
  readonly #directory: string;
  readonly #now: () => Date;

  constructor(options: ExtensionControlSystemObserverOptions) {
    this.#directory = options.directory;
    this.#now = options.now ?? (() => new Date());
  }

  async observe(_context: SystemObservationContext): Promise<readonly SystemEvidence[]> {
    const observedAt = this.#now().toISOString();
    const transaction = await readLatestExtensionControlTransaction(this.#directory);
    return [evidence({
      componentId: "floral.extension_control",
      fact: "last_transaction",
      sourceId: "extension-control-ledger",
      sourceKind: "filesystem",
      confidence: "authoritative",
      scope: "machine",
      value: transaction ? {
        schemaVersion: transaction.schemaVersion,
        id: transaction.id,
        kind: transaction.kind,
        targetId: transaction.targetId,
        action: transaction.action,
        status: transaction.status,
        requestedAt: transaction.requestedAt,
        updatedAt: transaction.updatedAt,
        changed: transaction.changed ?? null,
        expectedServerId: transaction.expectedServerId ?? null,
        expectedSkillNames: transaction.expectedSkillNames ?? [],
        verification: transaction.verification ?? null,
        errorType: transaction.errorType ?? null,
      } : null,
      observedAt,
    })];
  }
}
