import {
  listExtensionControlTransactions,
  readLatestExtensionControlTransaction,
  type ExtensionControlTransaction,
} from "../../extensions/extension-control.js";
import type {
  SystemEvidence,
  SystemEvidenceValue,
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
    const recent = await listExtensionControlTransactions(this.#directory, 50);
    return [evidence({
      componentId: "floral.extension_control",
      fact: "last_transaction",
      sourceId: "extension-control-ledger",
      sourceKind: "filesystem",
      confidence: "authoritative",
      scope: "machine",
      value: transaction ? transactionEvidence(transaction) : null,
      observedAt,
    }), evidence({
      componentId: "floral.extension_control",
      fact: "recent_transactions",
      sourceId: "extension-control-ledger",
      sourceKind: "filesystem",
      confidence: "authoritative",
      scope: "machine",
      value: recent.map(transactionEvidence),
      observedAt,
    })];
  }
}

function transactionEvidence(
  transaction: ExtensionControlTransaction,
): { readonly [key: string]: SystemEvidenceValue } {
  return {
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
    expiresAt: transaction.expiresAt ?? null,
    supersededBy: transaction.supersededBy ?? null,
  };
}
