import { stat } from "node:fs/promises";
import { readServiceState } from "../../runtime/service-state.js";
import type {
  SystemEvidence,
  SystemObservationContext,
  SystemObserver,
} from "../system-types.js";
import { evidence, errorType } from "./observer-utils.js";

export type ProcessLiveness = "alive" | "dead" | "unknown";

export interface ServiceStateSystemObserverOptions {
  statePath: string;
  now?: (() => Date) | undefined;
  checkProcess?: ((pid: number) => ProcessLiveness) | undefined;
}

export class ServiceStateSystemObserver implements SystemObserver {
  readonly id = "service-state";
  readonly componentIds = ["floral.service"] as const;

  readonly #statePath: string;
  readonly #now: () => Date;
  readonly #checkProcess: (pid: number) => ProcessLiveness;

  constructor(options: ServiceStateSystemObserverOptions) {
    this.#statePath = options.statePath;
    this.#now = options.now ?? (() => new Date());
    this.#checkProcess = options.checkProcess ?? checkProcessLiveness;
  }

  async observe(_context: SystemObservationContext): Promise<readonly SystemEvidence[]> {
    const observedAt = this.#now().toISOString();
    const filePresence = await serviceStateFilePresence(this.#statePath);
    const state = await readServiceState(this.#statePath);
    if (!state) {
      const presenceEvidence = filePresence === "unknown"
        ? evidence({
            componentId: "floral.service",
            fact: "recorded.present",
            sourceId: "service-state",
            sourceKind: "filesystem",
            confidence: "unknown",
            scope: "machine",
            value: null,
            observedAt,
            reason: "service-state-presence-unknown",
          })
        : filesystemEvidence("recorded.present", filePresence === "present", observedAt);
      return [
        presenceEvidence,
        evidence({
          componentId: "floral.service",
          fact: "recorded.phase",
          sourceId: "service-state",
          sourceKind: "filesystem",
          confidence: "unknown",
          scope: "machine",
          value: null,
          observedAt,
          reason: filePresence === "present" ? "service-state-invalid" : "service-state-unavailable",
        }),
        evidence({
          componentId: "floral.service",
          fact: "process.alive",
          sourceId: "process-liveness",
          sourceKind: "process",
          confidence: "unknown",
          scope: "machine",
          value: null,
          observedAt,
          reason: "recorded-pid-unavailable",
        }),
      ];
    }

    let liveness: ProcessLiveness;
    try {
      liveness = this.#checkProcess(state.pid);
    } catch (error) {
      liveness = "unknown";
      return [
        ...recordedStateEvidence(state, observedAt),
        evidence({
          componentId: "floral.service",
          fact: "process.alive",
          sourceId: "process-liveness",
          sourceKind: "process",
          confidence: "unknown",
          scope: "machine",
          value: null,
          observedAt,
          reason: `process-check-${errorType(error)}`,
        }),
      ];
    }

    return [
      ...recordedStateEvidence(state, observedAt),
      evidence({
        componentId: "floral.service",
        fact: "process.alive",
        sourceId: "process-liveness",
        sourceKind: "process",
        confidence: liveness === "unknown" ? "unknown" : "observed",
        scope: "machine",
        value: liveness === "unknown" ? null : liveness === "alive",
        observedAt,
        ...(liveness === "unknown" ? { reason: "process-liveness-unknown" } : {}),
      }),
    ];
  }
}

function recordedStateEvidence(
  state: NonNullable<Awaited<ReturnType<typeof readServiceState>>>,
  observedAt: string,
): SystemEvidence[] {
  return [
    filesystemEvidence("recorded.present", true, observedAt),
    filesystemEvidence("recorded.phase", state.phase, observedAt),
    filesystemEvidence("recorded.pid", state.pid, observedAt),
    filesystemEvidence("recorded.updated_at", state.updatedAt, observedAt),
  ];
}

function filesystemEvidence(
  fact: string,
  value: boolean | number | string,
  observedAt: string,
): SystemEvidence {
  return evidence({
    componentId: "floral.service",
    fact,
    sourceId: "service-state",
    sourceKind: "filesystem",
    confidence: "authoritative",
    scope: "machine",
    value,
    observedAt,
  });
}

export function checkProcessLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

async function serviceStateFilePresence(path: string): Promise<"present" | "missing" | "unknown"> {
  try {
    const metadata = await stat(path);
    return metadata.isFile() ? "present" : "unknown";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "unknown";
  }
}
