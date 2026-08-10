import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentSkillSummary } from "../core/contracts.js";
import type {
  AgentApprovalHandler,
  AgentApprovalRequest,
} from "../core/types.js";
import {
  ProjectSkillAuthoringManager,
  type ProjectSkillDraftReport,
} from "../skills/project-skill-authoring.js";
import {
  boundedDynamicToolText,
  safeDynamicToolToken,
} from "./floral-tool-response.js";

export interface FloralProjectSkillToolResult {
  success: boolean;
  text: string;
}

export class FloralProjectSkillToolController {
  readonly #managers = new Map<string, ProjectSkillAuthoringManager>();

  constructor(private readonly options: {
    runtimeDataRoot: string;
    listSkills: (cwd: string, forceReload: boolean) => Promise<AgentSkillSummary[]>;
    writeSkillEnabled: (path: string, enabled: boolean) => Promise<void>;
  }) {}

  async handle(input: {
    tool: string;
    arguments: Record<string, unknown>;
    cwd: string;
    callId: string;
    approvalHandler?: AgentApprovalHandler | undefined;
    onApprovalRequested?: ((approval: AgentApprovalRequest) => void) | undefined;
  }): Promise<FloralProjectSkillToolResult | undefined> {
    if (input.tool === "draft_status") return await this.#draftStatus(input.cwd, input.arguments);
    if (input.tool === "publication_history") {
      const text = await this.#manager(input.cwd).history().catch((error) =>
        `skill_publications=failed\nreason=${safeDynamicToolToken(error instanceof Error ? error.name : "Error")}`
      );
      return {
        success: !text.startsWith("skill_publications=failed"),
        text: boundedDynamicToolText(text),
      };
    }
    if (input.tool === "publish_draft") return await this.#publishDraft(input);
    return undefined;
  }

  async #draftStatus(
    cwd: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<FloralProjectSkillToolResult> {
    const name = readProjectSkillName(argumentsValue.name);
    if (!name) return { success: false, text: "project_skill_draft=denied\nreason=invalid-name" };
    const skills = await this.options.listSkills(cwd, true);
    const report = await this.#manager(cwd)
      .validateDraft(name, skills)
      .catch((error) => invalidProjectSkillReport(name, cwd, error));
    return {
      success: report.status === "validated",
      text: formatProjectSkillDraftReport(report),
    };
  }

  async #publishDraft(input: {
    arguments: Record<string, unknown>;
    cwd: string;
    callId: string;
    approvalHandler?: AgentApprovalHandler | undefined;
    onApprovalRequested?: ((approval: AgentApprovalRequest) => void) | undefined;
  }): Promise<FloralProjectSkillToolResult> {
    const name = readProjectSkillName(input.arguments.name);
    const requestedDigest = readSkillDraftDigest(input.arguments.digest);
    if (!name || !requestedDigest) {
      return { success: false, text: "project_skill_publish=denied\nreason=invalid-arguments" };
    }
    const manager = this.#manager(input.cwd);
    const initialSkills = await this.options.listSkills(input.cwd, true);
    const report = await manager.validateDraft(name, initialSkills).catch((error) =>
      invalidProjectSkillReport(name, input.cwd, error)
    );
    if (report.status !== "validated" || report.digest !== requestedDigest) {
      return {
        success: false,
        text: [
          "project_skill_publish=denied",
          `reason=${report.status !== "validated" ? "draft-invalid" : "digest-mismatch"}`,
          ...formatProjectSkillDraftReport(report).split("\n").slice(1),
        ].join("\n"),
      };
    }

    const approval: AgentApprovalRequest = {
      requestId: `skill-publish-${safeDynamicToolToken(input.callId)}`,
      kind: "skill-management",
      capability: "skill.publish",
      summary: `FLORAL Agent 请求${report.action === "create" ? "创建" : "更新"}当前项目 Skill：${name}`,
      source: "floral",
      scope: {
        type: "skill-publish",
        projectId: createHash("sha256").update(resolve(input.cwd), "utf8").digest("hex"),
        targetName: name,
        action: report.action,
        digest: requestedDigest,
        permissions: report.permissions,
      },
    };
    input.onApprovalRequested?.(approval);
    const decision = input.approvalHandler
      ? await input.approvalHandler(approval).catch(() => "deny" as const)
      : "deny";
    if (decision !== "approve" && decision !== "approve-session") {
      return { success: false, text: "project_skill_publish=denied\nreason=user-approval" };
    }

    const freshSkills = await this.options.listSkills(input.cwd, true);
    const freshReport = await manager.validateDraft(name, freshSkills).catch((error) =>
      invalidProjectSkillReport(name, input.cwd, error)
    );
    if (freshReport.status !== "validated" || freshReport.digest !== requestedDigest) {
      return { success: false, text: "project_skill_publish=denied\nreason=draft-changed-after-approval" };
    }
    const publication = await manager.publishValidatedDraft(freshReport).catch(() => undefined);
    if (!publication) {
      return { success: false, text: "project_skill_publish=failed\nreason=atomic-publication" };
    }

    try {
      let selected = (await this.options.listSkills(input.cwd, true)).find((skill) =>
        skill.name === name && pathIsInside(publication.targetPath, skill.path)
      );
      if (!selected) throw new Error("codex-native-discovery-failed");
      if (!selected.enabled) {
        await this.options.writeSkillEnabled(selected.path, true);
        selected = (await this.options.listSkills(input.cwd, true)).find((skill) =>
          skill.name === name && pathIsInside(publication.targetPath, skill.path)
        );
      }
      if (!selected?.enabled) throw new Error("codex-native-enable-failed");
      await manager.verifyPublication(
        publication,
        freshReport.permissions,
        "codex-native-discovery-and-config",
      );
      return {
        success: true,
        text: [
          "project_skill_publish=verified",
          `publication_id=${publication.publicationId}`,
          `name=${safeDynamicToolToken(name)}`,
          `action=${publication.action}`,
          `digest=${publication.digest}`,
          "enabled=true",
          "verification=codex-native-discovery",
          "rollback=not-required",
        ].join("\n"),
      };
    } catch (error) {
      await manager.rollbackPublication(
        publication,
        freshReport.permissions,
        error instanceof Error ? error.message : "verification-failed",
      ).catch(() => undefined);
      await this.options.listSkills(input.cwd, true).catch(() => undefined);
      return {
        success: false,
        text: "project_skill_publish=rolled-back\nreason=codex-native-verification",
      };
    }
  }

  #manager(cwd: string): ProjectSkillAuthoringManager {
    const normalized = resolve(cwd);
    let manager = this.#managers.get(normalized);
    if (!manager) {
      manager = new ProjectSkillAuthoringManager({
        cwd: normalized,
        runtimeDataRoot: this.options.runtimeDataRoot,
      });
      this.#managers.set(normalized, manager);
    }
    return manager;
  }
}

function readProjectSkillName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) ? name : undefined;
}

function readSkillDraftDigest(value: unknown): string | undefined {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value) ? value : undefined;
}

function pathIsInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function formatProjectSkillDraftReport(report: ProjectSkillDraftReport): string {
  return [
    `project_skill_draft=${report.status}`,
    `name=${safeDynamicToolToken(report.name)}`,
    `action=${report.action}`,
    ...(report.digest ? [`digest=${report.digest}`] : []),
    `files=${String(report.fileCount)}`,
    `bytes=${String(report.totalBytes)}`,
    `permissions=${report.permissions.join(",") || "none"}`,
    `expected_tools=${report.expectedTools.join(",") || "none"}`,
    `checks=${report.checks.join(",") || "none"}`,
    `errors=${report.errors.join(",") || "none"}`,
    ...(report.status === "validated"
      ? ["next=publish_draft", "publication_requires_exact_digest=true", "forward_test=required-after-publication-on-real-task"]
      : ["next=fix-draft-and-revalidate"]),
  ].join("\n");
}

function invalidProjectSkillReport(
  name: string,
  cwd: string,
  error: unknown,
): ProjectSkillDraftReport {
  return {
    status: "invalid",
    name,
    action: "create",
    draftPath: resolve(cwd, ".agents", "skill-drafts", name),
    targetPath: resolve(cwd, ".agents", "skills", name),
    permissions: [],
    expectedTools: [],
    fileCount: 0,
    totalBytes: 0,
    checks: [],
    errors: [safeDynamicToolToken(error instanceof Error ? error.message : "validation-failed")],
  };
}
