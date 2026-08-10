import type {
  DurableJournal,
  DurableJournalRecordInput,
  DurableJournalStatus,
} from "../core/contracts.js";
import type {
  DurableStateStore,
  DurableTransaction,
  DurableTransactionStatus,
} from "./durable-state.js";

export class SqliteDurableJournal implements DurableJournal {
  constructor(private readonly durability: DurableStateStore) {}

  record(input: DurableJournalRecordInput): { id: string; status: DurableJournalStatus } {
    let transaction = this.durability.createTransaction({
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      conversationId: input.conversationId,
      projectId: input.projectId,
      payload: input.payload,
      maxAttempts: 1,
    });
    if (isTerminal(transaction.status)) {
      if (transaction.status !== input.status) {
        throw new Error(`Durable journal receipt is already terminal: ${transaction.status}`);
      }
      return { id: transaction.id, status: input.status };
    }

    transaction = this.#advance(transaction, input);
    return { id: transaction.id, status: asJournalStatus(transaction.status) };
  }

  #advance(
    transaction: DurableTransaction,
    input: DurableJournalRecordInput,
  ): DurableTransaction {
    let current = transaction;
    if (current.status === "created" && input.status !== "failed" && input.status !== "cancelled") {
      current = this.#transition(current.id, "accepted", `${input.eventType}.accepted`, input);
    }
    if (input.status === "completed" && current.status === "accepted") {
      current = this.#transition(current.id, "executing", `${input.eventType}.executing`, input);
    }
    if (current.status === input.status) return current;
    return this.#transition(current.id, input.status, input.eventType, input);
  }

  #transition(
    id: string,
    status: DurableTransactionStatus,
    eventType: string,
    input: DurableJournalRecordInput,
  ): DurableTransaction {
    return this.durability.transition(id, {
      status,
      eventType,
      payload: input.payload,
      result: input.result,
      errorCode: input.errorCode,
    });
  }
}

function isTerminal(status: DurableTransactionStatus): status is "completed" | "failed" | "cancelled" {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function asJournalStatus(status: DurableTransactionStatus): DurableJournalStatus {
  if (status === "created") throw new Error("Durable journal receipt was not accepted");
  return status;
}
