import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";

const scenario = process.argv[2] ?? "normal";
const lines = createInterface({ input: process.stdin });
let initialized = false;
let resumed = false;
let activeThreadId = "thr_new";
let activeTurnId = "turn_1";
let waitingForApproval = false;
let extraSkillRoots = [];
const skillEnabled = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function hasFloralRoutingPolicy(params) {
  const instructions = params?.developerInstructions;
  return typeof instructions === "string"
    && instructions.includes("floral_peekaboo/see")
    && instructions.includes("floral_peekaboo/click")
    && instructions.includes("floral_delivery/send_artifact")
    && instructions.includes("local filesystem path")
    && instructions.includes("call floral_extensions/plan_extension first")
    && instructions.includes("floral_extensions/verify_extension")
    && instructions.includes("Extension control-plane routing overrides terminal-first")
    && instructions.includes("Do not inspect ~/.codex");
}

function hasFloralSystemPolicy(params) {
  const instructions = params?.developerInstructions;
  return typeof instructions === "string"
    && instructions.includes("FLORAL runtime self-awareness, diagnostics, and governed maintenance policy")
    && instructions.includes("For a broad FLORAL health/diagnosis request, call floral_system/diagnose first")
    && instructions.includes("Do not opportunistically run shell commands")
    && instructions.includes("Governed self-maintenance is exposed only through floral_system/maintain");
}

function hasFloralSkillTools(params) {
  const dynamicTools = params?.dynamicTools;
  if (!Array.isArray(dynamicTools)) return false;
  const namespace = dynamicTools.find((entry) =>
    entry?.type === "namespace" && entry?.name === "floral_skills"
  );
  if (!namespace || !Array.isArray(namespace.tools)) return false;
  const names = namespace.tools.map((tool) => tool?.name).sort();
  return JSON.stringify(names) === JSON.stringify([
    "external_catalog",
    "list",
    "manage_external",
    "refresh",
    "set_enabled",
  ]);
}

function hasFloralExtensionTools(params) {
  const dynamicTools = params?.dynamicTools;
  if (!Array.isArray(dynamicTools)) return false;
  const namespace = dynamicTools.find((entry) =>
    entry?.type === "namespace" && entry?.name === "floral_extensions"
  );
  if (!namespace || !Array.isArray(namespace.tools)) return false;
  const names = namespace.tools.map((tool) => tool?.name).sort();
  return JSON.stringify(names) === JSON.stringify([
    "apply_extension",
    "available_apps",
    "installed_apps",
    "manage_mcp",
    "mcp_catalog",
    "mcp_status",
    "native_status",
    "plan_extension",
    "prepare_app_install",
    "read_apps",
    "verify_extension",
  ]);
}

function hasFloralSystemTools(params) {
  const dynamicTools = params?.dynamicTools;
  if (!Array.isArray(dynamicTools)) return false;
  const namespace = dynamicTools.find((entry) =>
    entry?.type === "namespace" && entry?.name === "floral_system"
  );
  if (!namespace || !Array.isArray(namespace.tools)) return false;
  const names = namespace.tools.map((tool) => tool?.name).sort();
  return JSON.stringify(names) === JSON.stringify([
    "capabilities",
    "component_status",
    "current_context",
    "diagnose",
    "maintain",
    "system_summary",
  ]);
}

function hasFloralDeliveryTools(params) {
  const dynamicTools = params?.dynamicTools;
  if (!Array.isArray(dynamicTools)) return false;
  const namespace = dynamicTools.find((entry) =>
    entry?.type === "namespace" && entry?.name === "floral_delivery"
  );
  if (!namespace || !Array.isArray(namespace.tools)) return false;
  const names = namespace.tools.map((tool) => tool?.name).sort();
  return JSON.stringify(names) === JSON.stringify([
    "register_outbound_file",
    "send_artifact",
  ]);
}

function hasFloralContextTools(params) {
  const dynamicTools = params?.dynamicTools;
  if (!Array.isArray(dynamicTools)) return false;
  const namespace = dynamicTools.find((entry) =>
    entry?.type === "namespace" && entry?.name === "floral_context"
  );
  if (!namespace || !Array.isArray(namespace.tools)) return false;
  const names = namespace.tools.map((tool) => tool?.name).sort();
  return JSON.stringify(names) === JSON.stringify([
    "apply_update",
    "compact",
    "history",
    "propose_update",
    "read",
    "refresh_agents",
    "status",
    "verify",
  ]);
}

function sendSuccess(threadId = activeThreadId, turnId = activeTurnId, finalText = "authoritative final") {
  send({
    method: "item/agentMessage/delta",
    params: { threadId, turnId, itemId: "item_agent", delta: "streamed text" },
  });
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: { id: "item_agent", type: "agentMessage", text: finalText, phase: "final_answer" },
    },
  });
  send({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status: "completed", items: [] } },
  });
}

lines.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    if (scenario === "malformed") process.stdout.write("this-is-not-json\n");
    if (
      scenario === "delivery-dynamic-tools"
      && message.params?.capabilities?.experimentalApi !== true
    ) {
      send({
        id: message.id,
        error: {
          code: -32602,
          message: "dynamic tools require experimentalApi capability",
        },
      });
      return;
    }
    initialized = true;
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/fake" } });
    return;
  }

  if (message.method === "initialized") return;

  if (!initialized) {
    send({ id: message.id, error: { code: -32002, message: "Not initialized" } });
    return;
  }

  if (message.method === "permissionProfile/list") {
    if (message.params?.cwd !== undefined
      && (typeof message.params.cwd !== "string" || !isAbsolute(message.params.cwd))) {
      send({ id: message.id, error: { code: -32602, message: "permission profile cwd must be absolute" } });
      return;
    }
    const data = scenario === "permission-profile-missing"
      ? [{ id: ":read-only", description: "Read only", allowed: true }]
      : [
          { id: ":read-only", description: "Read only", allowed: true },
          { id: "floral-project", description: "FLORAL project isolation", allowed: true },
        ];
    send({ id: message.id, result: { data, nextCursor: null } });
    return;
  }

  if (message.method === "skills/extraRoots/set") {
    const roots = message.params?.extraRoots;
    if (
      !Array.isArray(roots)
      || roots.some((root) => typeof root !== "string" || !isAbsolute(root))
    ) {
      send({ id: message.id, error: { code: -32602, message: "skill roots must be absolute" } });
      return;
    }
    extraSkillRoots = roots;
    send({ id: message.id, result: {} });
    return;
  }

  if (message.method === "skills/list") {
    const cwd = Array.isArray(message.params?.cwds) ? message.params.cwds[0] : undefined;
    if (typeof cwd !== "string" || !isAbsolute(cwd)) {
      send({ id: message.id, error: { code: -32602, message: "skills cwd must be absolute" } });
      return;
    }
    const root = extraSkillRoots[0];
    const skills = typeof root === "string"
      ? [
          {
            name: "system-status",
            description: "Collect a read-only health summary of the Mac Agent host.",
            path: `${root}/system-status/SKILL.md`,
            scope: "user",
            enabled: true,
          },
          {
            name: "attachment-analysis",
            description: "Analyze user-provided FLORAL attachments safely.",
            path: `${root}/attachment-analysis/SKILL.md`,
            scope: "user",
            enabled: true,
          },
          {
            name: "macos-ui-operation",
            description: "Observe and safely operate the macOS GUI through FLORAL-owned Peekaboo.",
            path: `${root}/macos-ui-operation/SKILL.md`,
            scope: "user",
            enabled: true,
          },
          {
            name: "skill-manager",
            description: "Manage FLORAL and Codex Skills safely.",
            path: `${root}/skill-manager/SKILL.md`,
            scope: "user",
            enabled: true,
          },
          {
            name: "extension-manager",
            description: "Discover and bootstrap FLORAL extension capabilities safely.",
            path: `${root}/extension-manager/SKILL.md`,
            scope: "user",
            enabled: true,
          },
          ...(typeof extraSkillRoots[1] === "string"
            ? [{
                name: "superpowers:brainstorming",
                description: "Brainstorm before creative implementation work.",
                path: `${extraSkillRoots[1]}/brainstorming/SKILL.md`,
                scope: "user",
                enabled: skillEnabled.get(
                  resolve(extraSkillRoots[1], "brainstorming", "SKILL.md"),
                ) ?? true,
              }]
            : []),
        ]
      : [];
    send({ id: message.id, result: { data: [{ cwd, skills, errors: [] }] } });
    return;
  }

  if (message.method === "skills/config/write") {
    const path = message.params?.path;
    const enabled = message.params?.enabled;
    if (
      typeof path !== "string"
      || !isAbsolute(path)
      || typeof enabled !== "boolean"
    ) {
      send({
        id: message.id,
        error: { code: -32602, message: "invalid skill config write" },
      });
      return;
    }
    skillEnabled.set(resolve(path), enabled);
    send({ id: message.id, result: {} });
    send({ method: "skills/changed", params: {} });
    return;
  }

  if (message.method === "experimentalFeature/list") {
    send({
      id: message.id,
      result: {
        data: [
          {
            name: "apps",
            stage: "beta",
            displayName: "Apps",
            description: "Connector Apps",
            enabled: true,
            defaultEnabled: true,
          },
          {
            name: "plugins",
            stage: "underDevelopment",
            displayName: null,
            description: null,
            enabled: true,
            defaultEnabled: false,
          },
        ],
        nextCursor: null,
      },
    });
    return;
  }

  if (message.method === "app/installed") {
    if (scenario === "app-installed-fallback") {
      send({
        id: message.id,
        error: { code: -32601, message: "Method not found: app/installed" },
      });
      return;
    }
    send({
      id: message.id,
      result: {
        apps: [
          {
            id: "github",
            runtimeName: "GitHub",
            enabled: true,
            callable: true,
          },
          {
            id: "disabled-app",
            runtimeName: "Disabled App",
            enabled: false,
            callable: false,
          },
        ],
      },
    });
    return;
  }


  if (message.method === "app/list") {
    send({
      id: message.id,
      result: {
        data: [
          {
            id: "github",
            name: "GitHub",
            description: "GitHub connector directory entry",
            installUrl: "https://chatgpt.com/apps/github/github",
            isAccessible: true,
            isEnabled: true,
          },
          {
            id: "calendar-demo",
            name: "Calendar Demo",
            description: "Directory-only inaccessible example",
            installUrl: "https://chatgpt.com/apps/calendar-demo/calendar-demo",
            isAccessible: false,
            isEnabled: false,
          },
        ],
        nextCursor: null,
      },
    });
    return;
  }

  if (message.method === "mcpServerStatus/list") {
    if (message.params?.detail !== undefined) {
      send({
        id: message.id,
        error: { code: -32602, message: "unsupported MCP detail value" },
      });
      return;
    }
    send({
      id: message.id,
      result: {
        data: [
          {
            name: "github",
            authStatus: "authenticated",
            tools: {
              search_repositories: { annotations: { readOnlyHint: true } },
            },
          },
          {
            name: "chrome-devtools",
            authStatus: "not-required",
            tools: [
              { name: "navigate_page", annotations: { readOnlyHint: false } },
              { name: "take_screenshot", annotations: { readOnlyHint: true } },
            ],
          },
        ],
        nextCursor: null,
      },
    });
    return;
  }

  if (message.method === "config/mcpServer/reload") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "app/read") {
    const ids = message.params?.appIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100) {
      send({ id: message.id, error: { code: -32602, message: "invalid app ids" } });
      return;
    }
    const apps = ids.includes("github")
      ? [{
          id: "github",
          name: "GitHub",
          description: "Work with GitHub repositories and pull requests.",
          iconUrl: null,
          iconUrlDark: null,
          distributionChannel: null,
          installUrl: null,
          pluginDisplayNames: ["GitHub"],
          toolSummaries: message.params?.includeTools === true
            ? [{
                name: "search_repositories",
                title: "Search repositories",
                description: "Search GitHub repositories.",
                isEnabled: true,
                disabledReason: null,
                isReadOnly: true,
              }]
            : [],
        }]
      : [];
    send({
      id: message.id,
      result: {
        apps,
        missingAppIds: ids.filter((id) => id !== "github"),
      },
    });
    return;
  }

  if (scenario === "thread-management" && message.method === "thread/list") {
    if (typeof message.params?.cwd !== "string" || !isAbsolute(message.params.cwd)) {
      send({ id: message.id, error: { code: -32602, message: "thread list cwd must be absolute" } });
      return;
    }
    send({
      id: message.id,
      result: {
        data: [
          {
            id: "thr_project_newer",
            preview: "Newest project thread\nwith extra spacing",
            createdAt: 200,
            updatedAt: 250,
          },
          {
            id: "thr_project_older",
            preview: "Older project thread",
            createdAt: 100,
            updatedAt: 150,
          },
        ],
        nextCursor: null,
      },
    });
    return;
  }

  if (scenario === "thread-management" && message.method === "thread/archive") {
    if (message.params?.threadId !== "thr_project_older") {
      send({ id: message.id, error: { code: -32602, message: "unexpected archive thread id" } });
      return;
    }
    send({ id: message.id, result: {} });
    return;
  }

  if (message.method === "thread/start") {
    if (
      (scenario === "developer-instructions" || scenario === "delivery-dynamic-tools")
      && !hasFloralRoutingPolicy(message.params)
    ) {
      send({ id: message.id, error: { code: -32602, message: "missing FLORAL developer instructions" } });
      return;
    }
    if ((scenario === "system-awareness" || scenario === "runtime-self-awareness" || scenario === "self-diagnostics" || scenario === "self-maintenance") && !hasFloralSystemTools(message.params)) {
      send({ id: message.id, error: { code: -32602, message: "missing FLORAL system dynamic tools" } });
      return;
    }
    if (
      (scenario === "system-awareness" || scenario === "runtime-self-awareness" || scenario === "self-diagnostics" || scenario === "self-maintenance")
      && !hasFloralSystemPolicy(message.params)
    ) {
      send({ id: message.id, error: { code: -32602, message: "missing FLORAL system awareness policy" } });
      return;
    }
    if (scenario === "delivery-dynamic-tools" && !hasFloralDeliveryTools(message.params)) {
      send({ id: message.id, error: { code: -32602, message: "missing FLORAL delivery dynamic tools" } });
      return;
    }
    if (scenario === "context-propose-apply" && !hasFloralContextTools(message.params)) {
      send({ id: message.id, error: { code: -32602, message: "missing FLORAL context dynamic tools" } });
      return;
    }
    if (
      (scenario === "extension-dynamic-tools"
        || scenario === "extension-plan"
        || scenario === "extension-apply-mcp"
        || scenario === "extension-installed-apps"
        || scenario === "extension-available-apps"
        || scenario === "extension-app-install-handoff"
        || scenario === "extension-mcp-status"
        || scenario === "extension-mcp-install"
        || scenario === "extension-mcp-install-status-pending"
        || scenario === "extension-mcp-install-shell-verification")
      && !hasFloralExtensionTools(message.params)
    ) {
      send({ id: message.id, error: { code: -32602, message: "missing FLORAL extension dynamic tools" } });
      return;
    }
    if (
      (scenario === "skill-control-disable"
        || scenario === "skill-external-install")
      && !hasFloralSkillTools(message.params)
    ) {
      send({
        id: message.id,
        error: { code: -32602, message: "missing FLORAL Skill dynamic tools" },
      });
      return;
    }
    if (scenario === "on-request-file-approval") {
      const capabilityFields = ["approvalPolicy", "approvalsReviewer", "sandbox"];
      if (capabilityFields.some((key) => key in (message.params ?? {}))) {
        send({ id: message.id, error: { code: -32602, message: "thread bootstrap must stay capability-neutral" } });
        return;
      }
      if (typeof message.params?.cwd !== "string" || !isAbsolute(message.params.cwd)) {
        send({ id: message.id, error: { code: -32602, message: "thread cwd must be absolute" } });
        return;
      }
    }
    activeThreadId = "thr_new";
    send({ id: message.id, result: { thread: { id: activeThreadId } } });
    return;
  }

  if (message.method === "thread/resume") {
    if ((scenario === "resume" || scenario === "resume-system-awareness") && !hasFloralRoutingPolicy(message.params)) {
      send({ id: message.id, error: { code: -32602, message: "resume missing FLORAL developer instructions" } });
      return;
    }
    if (scenario === "resume-system-awareness" && !hasFloralSystemPolicy(message.params)) {
      send({ id: message.id, error: { code: -32602, message: "resume missing FLORAL system awareness policy" } });
      return;
    }
    if (scenario === "stale-resume") {
      send({
        id: message.id,
        error: {
          code: -32602,
          message: `thread not found: ${String(message.params?.threadId)}`,
        },
      });
      return;
    }
    if (scenario === "resume-config-error") {
      send({
        id: message.id,
        error: {
          code: -32600,
          message: "failed to load configuration: /tmp/config.toml:12:1: invalid type",
        },
      });
      return;
    }
    resumed = true;
    activeThreadId = message.params.threadId;
    send({ id: message.id, result: { thread: { id: activeThreadId } } });
    return;
  }

  if (message.method === "test/batched-server-request") {
    const response = { id: message.id, result: { accepted: true } };
    const serverRequest = {
      id: "batched_request_1",
      method: "test/serverRequest",
      params: { source: "same-stdout-chunk" },
    };
    process.stdout.write(`${JSON.stringify(response)}\n${JSON.stringify(serverRequest)}\n`);
    return;
  }

  if (message.method === "turn/start") {
    if (scenario === "app-mention") {
      const input = message.params?.input;
      const mention = Array.isArray(input)
        ? input.find((item) => item?.type === "mention" && item?.path === "app://github")
        : undefined;
      if (!mention || mention?.name !== "GitHub") {
        send({ id: message.id, error: { code: -32602, message: "missing GitHub App mention" } });
        return;
      }
    }

    if (scenario === "project-permissions" || scenario === "runtime-self-awareness") {
      if (message.params?.permissions !== "floral-project") {
        send({ id: message.id, error: { code: -32602, message: "missing project permission profile" } });
        return;
      }
      if (message.params?.sandboxPolicy !== undefined) {
        send({ id: message.id, error: { code: -32602, message: "permissions cannot be combined with sandboxPolicy" } });
        return;
      }
      const roots = message.params?.runtimeWorkspaceRoots;
      if (
        typeof message.params?.cwd !== "string"
        || !isAbsolute(message.params.cwd)
        || !Array.isArray(roots)
        || roots.length !== 1
        || roots[0] !== message.params.cwd
      ) {
        send({ id: message.id, error: { code: -32602, message: "project runtimeWorkspaceRoots must equal cwd" } });
        return;
      }
    }
    if (scenario === "on-request-file-approval" && message.params?.approvalPolicy !== "untrusted") {
      send({
        id: message.id,
        error: { code: -32602, message: `invalid turn approval policy: ${String(message.params?.approvalPolicy)}` },
      });
      return;
    }
    if (scenario === "on-request-file-approval" && message.params?.sandboxPolicy?.type !== "workspaceWrite") {
      send({
        id: message.id,
        error: {
          code: -32602,
          message: `invalid turn sandbox policy: ${String(message.params?.sandboxPolicy?.type)}`,
        },
      });
      return;
    }
    if (scenario === "on-request-file-approval" && message.params?.approvalsReviewer !== "user") {
      send({ id: message.id, error: { code: -32602, message: "approval reviewer must be user" } });
      return;
    }
    if (scenario === "auto-review" && message.params?.approvalsReviewer !== "auto_review") {
      send({ id: message.id, error: { code: -32602, message: "approval reviewer must be auto_review" } });
      return;
    }
    if (scenario === "full-access-turn") {
      if (message.params?.approvalPolicy !== "untrusted") {
        send({ id: message.id, error: { code: -32602, message: "full approval policy must be untrusted" } });
        return;
      }
      if (message.params?.sandboxPolicy?.type !== "dangerFullAccess") {
        send({ id: message.id, error: { code: -32602, message: "full sandbox must be dangerFullAccess" } });
        return;
      }
      if (message.params?.approvalsReviewer !== "user") {
        send({ id: message.id, error: { code: -32602, message: "full reviewer must remain user for client interception" } });
        return;
      }
    }
    if (scenario === "on-request-file-approval") {
      const roots = message.params?.sandboxPolicy?.writableRoots;
      if (
        typeof message.params?.cwd !== "string"
        || !isAbsolute(message.params.cwd)
        || !Array.isArray(roots)
        || roots.length !== 1
        || roots[0] !== message.params.cwd
        || message.params?.sandboxPolicy?.networkAccess !== false
      ) {
        send({ id: message.id, error: { code: -32602, message: "workspaceWrite must be absolute cwd-only and network-disabled" } });
        return;
      }
    }
    if ((scenario === "resume" || scenario === "resume-system-awareness") && !resumed) {
      send({ id: message.id, error: { code: -32602, message: "thread was not resumed" } });
      return;
    }

    if (scenario === "skills-explicit") {
      const input = message.params?.input;
      const text = Array.isArray(input)
        ? input.find((item) => item?.type === "text")?.text
        : undefined;
      const requestedSkill = typeof text === "string"
        && text.includes("$superpowers:brainstorming")
        ? "superpowers:brainstorming"
        : typeof text === "string"
          && text.includes("$macos-ui-operation")
          ? "macos-ui-operation"
          : "system-status";
      const expectedDirectory = requestedSkill.includes(":")
        ? requestedSkill.split(":").at(-1)
        : requestedSkill;
      const skill = Array.isArray(input)
        ? input.find((item) =>
            item?.type === "skill" && item?.name === requestedSkill
          )
        : undefined;
      const normalizedSkillPath = typeof skill?.path === "string"
        ? skill.path.replace(/\\/gu, "/")
        : "";
      if (
        !skill
        || !expectedDirectory
        || !normalizedSkillPath.endsWith(`/${expectedDirectory}/SKILL.md`)
      ) {
        send({ id: message.id, error: { code: -32602, message: "missing explicit skill input item" } });
        return;
      }
    }

    activeThreadId = message.params.threadId;
    activeTurnId = (scenario === "resume" || scenario === "resume-system-awareness") ? "turn_resumed" : "turn_1";
    send({ id: message.id, result: { turn: { id: activeTurnId, status: "inProgress" } } });

    setImmediate(() => {
      if (scenario === "auto-review") {
        sendSuccess(activeThreadId, activeTurnId, "auto review configured");
        return;
      }

      if (scenario === "full-access-turn") {
        sendSuccess(activeThreadId, activeTurnId, "full access configured");
        return;
      }

      if (scenario === "permission-approval" || scenario === "permission-session-approval") {
        waitingForApproval = true;
        send({
          id: "approval_permission_1",
          method: "item/permissions/requestApproval",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            itemId: "permission_1",
            environmentId: null,
            startedAtMs: Date.now(),
            cwd: process.cwd(),
            reason: "need network and one extra read root",
            permissions: {
              network: { enabled: true },
              fileSystem: {
                read: ["/tmp/shared"],
                write: null,
              },
            },
          },
        });
        return;
      }

      if (scenario === "quota") {
        const error = {
          message: "You've hit your usage limit.",
          codexErrorInfo: { type: "UsageLimitExceeded" },
        };
        send({ method: "error", params: { threadId: activeThreadId, turnId: activeTurnId, error } });
        send({
          method: "turn/completed",
          params: {
            threadId: activeThreadId,
            turn: { id: activeTurnId, status: "failed", error, items: [] },
          },
        });
        return;
      }

      if (scenario === "on-request-file-approval") {
        waitingForApproval = true;
        send({
          method: "item/started",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "patch_1",
              type: "fileChange",
              status: "inProgress",
              changes: [
                { path: "src/example.ts", kind: "update", diff: "+ const secret = 'not-for-approval';" },
              ],
            },
          },
        });
        send({
          id: "approval_1",
          method: "item/fileChange/requestApproval",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            itemId: "patch_1",
            reason: "update one workspace file",
          },
        });
        return;
      }

      if (scenario === "approval") {
        waitingForApproval = true;
        send({
          id: "approval_1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            itemId: "command_1",
            command: "echo unsafe --token supersecret",
            cwd: process.cwd(),
            reason: "fixture approval",
          },
        });
        return;
      }

      if (scenario === "gui-shell-bypass") {
        waitingForApproval = true;
        send({
          id: "approval_1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            itemId: "command_gui_1",
            command: "/opt/homebrew/bin/peekaboo click --on button_42",
            cwd: process.cwd(),
            reason: "attempt GUI control through shell",
          },
        });
        return;
      }

      if (scenario === "mcp-approval") {
        waitingForApproval = true;
        send({
          method: "item/started",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "mcp_click_1",
              type: "mcpToolCall",
              server: "floral_peekaboo",
              tool: "click",
              status: "inProgress",
              arguments: {
                snapshot: "snapshot-1",
                on: "button_42",
                intent: "展开 VS Code 的 src 文件夹",
              },
            },
          },
        });
        send({
          id: "approval_1",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            serverName: "floral_peekaboo",
            mode: "form",
            _meta: {
              codex_approval_kind: "mcp_tool_call",
              tool_title: "Click",
              tool_params: {
                snapshot: "snapshot-1",
                on: "button_42",
                intent: "展开 VS Code 的 src 文件夹",
              },
            },
            message: "Allow floral_peekaboo to run tool click?",
            requestedSchema: { type: "object", properties: {} },
          },
        });
        return;
      }

      if (scenario === "mcp-artifact") {
        send({
          method: "item/started",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "mcp_artifact_1",
              type: "mcpToolCall",
              server: "floral_peekaboo",
              tool: "image",
              status: "inProgress",
            },
          },
        });
        send({
          method: "item/completed",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "mcp_artifact_1",
              type: "mcpToolCall",
              server: "floral_peekaboo",
              tool: "image",
              status: "completed",
              result: {
                content: [{
                  type: "text",
                  text: "artifactId=artifact-screen-fixture\nartifactPath=/tmp/floral-screen.png\nsource=floral_peekaboo/image",
                }],
                structuredContent: null,
                _meta: null,
              },
            },
          },
        });
        sendSuccess(activeThreadId, activeTurnId, "artifact captured");
        return;
      }

      if (scenario === "system-awareness") {
        send({
          id: "dynamic_1",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_system_summary_1",
            namespace: "floral_system",
            tool: "system_summary",
            arguments: {},
          },
        });
        return;
      }

      if (scenario === "context-propose-apply") {
        send({
          id: "dynamic_1",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_context_propose_1",
            namespace: "floral_context",
            tool: "propose_update",
            arguments: {
              target: "context",
              text: "The governed context interface requires host approval for writes.",
              evidence_refs: ["tests:context-propose-apply"],
            },
          },
        });
        return;
      }

      if (scenario === "runtime-self-awareness") {
        send({
          id: "dynamic_1",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_current_context_1",
            namespace: "floral_system",
            tool: "current_context",
            arguments: {},
          },
        });
        return;
      }

      if (scenario === "self-diagnostics") {
        send({
          id: "dynamic_1",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_diagnose_1",
            namespace: "floral_system",
            tool: "diagnose",
            arguments: { component_id: "floral.service" },
          },
        });
        return;
      }

      if (scenario === "self-maintenance") {
        send({
          id: "dynamic_1",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_maintain_1",
            namespace: "floral_system",
            tool: "maintain",
            arguments: {
              component_id: "floral.service",
              action_id: "restart",
              rationale: "service diagnosis requires a governed restart",
            },
          },
        });
        return;
      }

      if (scenario === "delivery-register") {
        send({
          id: "dynamic_1",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_register_1",
            namespace: "floral_delivery",
            tool: "register_outbound_file",
            arguments: {
              local_path: "/tmp/outbound/report.txt",
              file_name: "report.txt",
            },
          },
        });
        return;
      }

      if (scenario === "delivery-send") {
        send({
          id: "dynamic_1",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_send_1",
            namespace: "floral_delivery",
            tool: "send_artifact",
            arguments: {
              artifact_id: "artifact-screen-fixture",
              caption: "current screen",
            },
          },
        });
        return;
      }

      if (scenario === "extension-apply-mcp") {
        send({
          id: "dynamic_1",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_extensions_apply_1",
            namespace: "floral_extensions",
            tool: "apply_extension",
            arguments: { kind: "mcp", action: "install", id: "chrome-devtools" },
          },
        });
        return;
      }

      if (scenario === "extension-plan") {
        send({
          id: "dynamic_1",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_extensions_plan_1",
            namespace: "floral_extensions",
            tool: "plan_extension",
            arguments: { kind: "mcp", id: "chrome-devtools", intent: "activate" },
          },
        });
        return;
      }

      if (scenario === "extension-installed-apps") {
        send({
          id: "dynamic_1",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_extensions_apps_1",
            namespace: "floral_extensions",
            tool: "installed_apps",
            arguments: {},
          },
        });
        return;
      }

      if (scenario === "extension-available-apps") {
        send({
          id: "dynamic_1",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_extensions_available_apps_1",
            namespace: "floral_extensions",
            tool: "available_apps",
            arguments: {},
          },
        });
        return;
      }

      if (scenario === "extension-app-install-handoff") {
        send({
          id: "dynamic_1",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_extensions_app_handoff_1",
            namespace: "floral_extensions",
            tool: "prepare_app_install",
            arguments: { app_id: "github" },
          },
        });
        return;
      }

      if (scenario === "extension-mcp-status") {
        send({
          id: "dynamic_1",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_extensions_mcp_status_1",
            namespace: "floral_extensions",
            tool: "mcp_status",
            arguments: {},
          },
        });
        return;
      }

      if (
        scenario === "extension-mcp-install"
        || scenario === "extension-mcp-install-status-pending"
        || scenario === "extension-mcp-install-shell-verification"
      ) {
        send({
          id: "dynamic_1",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_extensions_mcp_install_1",
            namespace: "floral_extensions",
            tool: "manage_mcp",
            arguments: { action: "install", id: "chrome-devtools" },
          },
        });
        return;
      }

      if (scenario === "external-mcp-approval") {
        waitingForApproval = true;
        send({
          method: "item/started",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "mcp_browser_1",
              type: "mcpToolCall",
              server: "chrome-devtools",
              tool: "navigate_page",
              status: "inProgress",
              arguments: { url: "https://example.com" },
            },
          },
        });
        send({
          id: "approval_1",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            serverName: "chrome-devtools",
            mode: "form",
            _meta: {
              codex_approval_kind: "mcp_tool_call",
              tool_title: "Navigate page",
              tool_params: { url: "https://example.com" },
            },
            message: "Allow chrome-devtools to navigate?",
            requestedSchema: { type: "object", properties: {} },
          },
        });
        return;
      }

      if (scenario === "skill-control-disable") {
        send({
          id: "dynamic_1",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_skill_disable_1",
            namespace: "floral_skills",
            tool: "set_enabled",
            arguments: {
              name: "superpowers:brainstorming",
              enabled: false,
            },
          },
        });
        return;
      }

      if (scenario === "skill-external-install") {
        send({
          id: "dynamic_1",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_skill_install_1",
            namespace: "floral_skills",
            tool: "manage_external",
            arguments: {
              action: "install",
              id: "superpowers",
            },
          },
        });
        return;
      }

      if (scenario === "mcp-tool") {
        send({
          method: "item/started",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "mcp_1",
              type: "mcpToolCall",
              server: "floral_search",
              tool: "searxng_web_search",
              status: "inProgress",
            },
          },
        });
        send({
          method: "item/completed",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "mcp_1",
              type: "mcpToolCall",
              server: "floral_search",
              tool: "searxng_web_search",
              status: "completed",
            },
          },
        });
        sendSuccess(activeThreadId, activeTurnId, "search complete");
        return;
      }

      if (scenario === "tool-after-commentary-without-final") {
        send({
          method: "item/completed",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "commentary_1",
              type: "agentMessage",
              text: "我来搜索一下大模型可视化相关的开源项目和工具：",
              phase: "commentary",
            },
          },
        });
        send({
          method: "item/started",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "mcp_1",
              type: "mcpToolCall",
              server: "floral_search",
              tool: "searxng_web_search",
              status: "inProgress",
            },
          },
        });
        send({
          method: "item/completed",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "mcp_1",
              type: "mcpToolCall",
              server: "floral_search",
              tool: "searxng_web_search",
              status: "completed",
            },
          },
        });
        send({
          method: "turn/completed",
          params: {
            threadId: activeThreadId,
            turn: {
              id: activeTurnId,
              status: "completed",
              items: [
                {
                  id: "commentary_1",
                  type: "agentMessage",
                  text: "我来搜索一下大模型可视化相关的开源项目和工具：",
                  phase: "commentary",
                },
                {
                  id: "mcp_1",
                  type: "mcpToolCall",
                  server: "floral_search",
                  tool: "searxng_web_search",
                  status: "completed",
                },
              ],
            },
          },
        });
        return;
      }

      if (scenario === "unphased-message-before-tool-without-final") {
        send({
          method: "item/agentMessage/delta",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            itemId: "message_1",
            delta: "我来搜索一下：",
          },
        });
        send({
          method: "item/completed",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "message_1",
              type: "agentMessage",
              text: "我来搜索一下：",
            },
          },
        });
        send({
          method: "item/started",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "command_1",
              type: "commandExecution",
              status: "inProgress",
            },
          },
        });
        send({
          method: "item/completed",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "command_1",
              type: "commandExecution",
              status: "completed",
            },
          },
        });
        send({
          method: "turn/completed",
          params: {
            threadId: activeThreadId,
            turn: {
              id: activeTurnId,
              status: "completed",
              items: [
                { id: "message_1", type: "agentMessage", text: "我来搜索一下：" },
                { id: "command_1", type: "commandExecution", status: "completed" },
              ],
            },
          },
        });
        return;
      }

      if (scenario === "terminal-final-after-commentary") {
        send({
          method: "item/completed",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "commentary_1",
              type: "agentMessage",
              text: "我先看一下路线图和最近的阶段文档，确认当前开发进度：",
              phase: "commentary",
            },
          },
        });
        send({
          method: "item/started",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "mcp_1",
              type: "mcpToolCall",
              server: "floral_search",
              tool: "searxng_web_search",
              status: "inProgress",
            },
          },
        });
        send({
          method: "item/completed",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "mcp_1",
              type: "mcpToolCall",
              server: "floral_search",
              tool: "searxng_web_search",
              status: "completed",
            },
          },
        });
        send({
          method: "turn/completed",
          params: {
            threadId: activeThreadId,
            turn: {
              id: activeTurnId,
              status: "completed",
              items: [
                {
                  id: "commentary_1",
                  type: "agentMessage",
                  text: "我先看一下路线图和最近的阶段文档，确认当前开发进度：",
                  phase: "commentary",
                },
                {
                  id: "final_1",
                  type: "agentMessage",
                  text: "FLORAL 当前处于 Phase 5.4 QQ Conversation UX 阶段。",
                  phase: "final_answer",
                },
              ],
            },
          },
        });
        return;
      }

      if (scenario === "timeout") return;
      if (scenario === "exit-turn") {
        process.stderr.write("fixture forced exit\n");
        process.exit(17);
      }

      sendSuccess(
        activeThreadId,
        activeTurnId,
        (scenario === "resume" || scenario === "resume-system-awareness")
          ? "resumed final"
          : scenario === "stale-resume"
            ? "recovered final"
            : "authoritative final",
      );
    });
    return;
  }

  if (message.id === "dynamic_2" && "result" in message) {
    const success = message.result?.success;
    const text = message.result?.contentItems?.[0]?.text ?? "";
    if (
      scenario === "context-propose-apply"
      && success === true
      && text.includes("context_update=applied")
      && text.includes("target=context")
      && text.includes("ledger_entry_id=")
      && text.includes("verification_tool=floral_context/verify")
    ) {
      sendSuccess(activeThreadId, activeTurnId, "context update applied");
      return;
    }
    if (
      scenario === "extension-mcp-install-status-pending"
      && success === true
      && text.includes("codex_mcp.verification=pending")
      && text.includes("next=verify-on-next-turn")
      && text.includes("shell_verification=forbidden")
    ) {
      sendSuccess(activeThreadId, activeTurnId, "extension mcp verification deferred safely");
      return;
    }
    send({
      method: "turn/completed",
      params: {
        threadId: activeThreadId,
        turn: {
          id: activeTurnId,
          status: "failed",
          error: { message: `unexpected second dynamic tool response: ${text}` },
          items: [],
        },
      },
    });
    return;
  }

  if (message.id === "dynamic_1" && "result" in message) {
    const success = message.result?.success;
    const text = message.result?.contentItems?.[0]?.text ?? "";
    if (scenario === "context-propose-apply" && success === true) {
      const proposalId = /^proposal_id=(ctx-[a-f0-9]{20})$/mu.exec(text)?.[1];
      if (proposalId && text.includes("context_proposal=created") && text.includes("next=apply_update")) {
        send({
          id: "dynamic_2",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_context_apply_1",
            namespace: "floral_context",
            tool: "apply_update",
            arguments: { proposal_id: proposalId },
          },
        });
        return;
      }
    }
    if (
      scenario === "system-awareness"
      && success === true
      && text.includes("FLORAL System Awareness")
      && text.includes("snapshot_semantics=read-only-per-turn-frozen")
      && text.includes("unknown_semantics=unknown-is-a-valid-state")
    ) {
      sendSuccess(activeThreadId, activeTurnId, "system awareness complete");
      return;
    }
    if (
      scenario === "runtime-self-awareness"
      && success === true
      && text.includes("FLORAL Runtime Self-Awareness")
      && text.includes("fact=turn.selector")
      && text.includes('value="permission-profile"')
      && text.includes("fact=turn.permission_profile")
      && text.includes('value="floral-project"')
      && text.includes("precedence=turn-effective-selector-over-gateway-request-over-configured-default")
    ) {
      sendSuccess(activeThreadId, activeTurnId, "runtime self awareness complete");
      return;
    }
    if (
      scenario === "self-diagnostics"
      && success === true
      && text.includes("FLORAL Self-Diagnostics")
      && text.includes("scope=floral.service")
      && text.includes("execution_performed=false")
      && text.includes("maintenance_enabled=true")
    ) {
      sendSuccess(activeThreadId, activeTurnId, "self diagnostics complete");
      return;
    }
    if (
      scenario === "self-maintenance"
      && success === true
      && text.includes("system_maintenance=queued")
      && text.includes("component=floral.service")
      && text.includes("action=restart")
      && text.includes("execution_performed=false")
      && text.includes("verification=pending-next-service-instance")
    ) {
      sendSuccess(activeThreadId, activeTurnId, "self maintenance queued");
      return;
    }
    if (
      scenario === "delivery-register"
      && success === true
      && text.includes("artifact_registration=registered")
      && text.includes("artifactId=artifact-file-fixture")
    ) {
      sendSuccess(activeThreadId, activeTurnId, "delivery register complete");
      return;
    }
    if (
      scenario === "delivery-send"
      && success === true
      && text.includes("artifact_delivery=sent")
      && text.includes("artifactId=artifact-screen-fixture")
    ) {
      sendSuccess(activeThreadId, activeTurnId, "delivery send complete");
      return;
    }
    if (
      scenario === "extension-apply-mcp"
      && success === true
      && text.includes("external_mcp.install=ok")
      && text.includes("id=chrome-devtools")
      && text.includes("verification=pending-fresh-turn")
      && text.includes("verification_tool=floral_extensions/verify_extension")
      && text.includes("same_turn_verification=forbidden")
    ) {
      sendSuccess(activeThreadId, activeTurnId, "extension apply complete");
      return;
    }
    if (
      scenario === "extension-plan"
      && success === true
      && text.includes("FLORAL Controlled Extension Plan")
      && text.includes("kind=mcp")
      && text.includes("id=chrome-devtools")
      && text.includes("status=action-required")
      && text.includes("recommended_action=install")
      && text.includes("execution_performed=false")
    ) {
      sendSuccess(activeThreadId, activeTurnId, "extension plan complete");
      return;
    }
    if (
      scenario === "extension-installed-apps"
      && success === true
      && text.includes("codex_apps.discovered=2")
      && text.includes("id=github")
      && text.includes("callable=true")
    ) {
      sendSuccess(activeThreadId, activeTurnId, "extension apps complete");
      return;
    }
    if (
      scenario === "extension-available-apps"
      && success === true
      && text.includes("codex_apps.available=2")
      && text.includes("install=supported-handoff")
    ) {
      sendSuccess(activeThreadId, activeTurnId, "extension available apps complete");
      return;
    }
    if (
      scenario === "extension-app-install-handoff"
      && success === true
      && text.includes("app_install_handoff=required")
      && text.includes("app_id=github")
      && text.includes("install_url=https://chatgpt.com/apps/github/github")
    ) {
      sendSuccess(activeThreadId, activeTurnId, "extension app handoff complete");
      return;
    }
    if (
      scenario === "extension-mcp-status"
      && success === true
      && text.includes("codex_mcp.servers=2")
      && text.includes("server=github")
      && text.includes("server=chrome-devtools")
    ) {
      sendSuccess(activeThreadId, activeTurnId, "extension mcp status complete");
      return;
    }
    if (
      (scenario === "extension-mcp-install"
        || scenario === "extension-mcp-install-status-pending"
        || scenario === "extension-mcp-install-shell-verification")
      && success === true
      && text.includes("external_mcp.install=ok")
      && text.includes("id=chrome-devtools")
      && text.includes("verification=next-turn")
      && text.includes("shell_verification=forbidden")
    ) {
      if (scenario === "extension-mcp-install-status-pending") {
        send({
          id: "dynamic_2",
          method: "item/tool/call",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            callId: "call_extensions_mcp_status_after_install",
            namespace: "floral_extensions",
            tool: "mcp_status",
            arguments: {},
          },
        });
        return;
      }
      if (scenario === "extension-mcp-install-shell-verification") {
        waitingForApproval = true;
        send({
          id: "approval_1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            itemId: "command_extension_verify_1",
            command: "/bin/zsh -lc \"ps aux | grep -i chrome-devtools; ls -la ~/.codex\"",
            cwd: process.cwd(),
            reason: "verify MCP installation with shell",
          },
        });
        return;
      }
      sendSuccess(activeThreadId, activeTurnId, "extension mcp install complete");
      return;
    }
    if (
      scenario === "skill-control-disable"
      && success === true
      && text.includes("skill_config=updated")
      && text.includes("enabled=false")
    ) {
      sendSuccess(activeThreadId, activeTurnId, "skill disable complete");
      return;
    }
    if (
      scenario === "skill-external-install"
      && success === true
      && text.includes("external_skills.install=ok")
      && text.includes("id=superpowers")
    ) {
      sendSuccess(activeThreadId, activeTurnId, "external skill install complete");
      return;
    }
    send({
      method: "turn/completed",
      params: {
        threadId: activeThreadId,
        turn: {
          id: activeTurnId,
          status: "failed",
          error: { message: `unexpected dynamic tool response: ${text}` },
          items: [],
        },
      },
    });
    return;
  }

  if (
    waitingForApproval
    && message.id === "approval_permission_1"
    && "result" in message
  ) {
    waitingForApproval = false;
    const expectedScope = scenario === "permission-session-approval" ? "session" : "turn";
    const permissions = message.result?.permissions;
    const valid = message.result?.scope === expectedScope
      && permissions?.network?.enabled === true
      && Array.isArray(permissions?.fileSystem?.read)
      && permissions.fileSystem.read.length === 1
      && permissions.fileSystem.read[0] === "/tmp/shared"
      && permissions?.fileSystem?.write === null;
    if (valid) {
      sendSuccess(
        activeThreadId,
        activeTurnId,
        scenario === "permission-session-approval"
          ? "permission session approval accepted safely"
          : "permission approval accepted safely",
      );
    } else {
      const error = {
        message: `unexpected permission response: ${JSON.stringify(message.result)}`,
        codexErrorInfo: "Other",
      };
      send({
        method: "turn/completed",
        params: {
          threadId: activeThreadId,
          turn: { id: activeTurnId, status: "failed", error, items: [] },
        },
      });
    }
    return;
  }

  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({
      method: "turn/completed",
      params: {
        threadId: message.params.threadId,
        turn: { id: message.params.turnId, status: "interrupted", items: [] },
      },
    });
    return;
  }

  if (message.method === "test/exit") {
    process.stderr.write("fixture request exit\n");
    process.exit(23);
  }

  if (waitingForApproval && message.id === "approval_1" && "result" in message) {
    waitingForApproval = false;
    if (scenario === "mcp-approval" || scenario === "external-mcp-approval") {
      const action = message.result?.action;
      if (action === "decline") {
        sendSuccess(activeThreadId, activeTurnId, "mcp approval declined safely");
      } else if (
        action === "accept"
        && message.result?.content
        && Object.keys(message.result.content).length === 0
        && message.result?._meta === null
      ) {
        sendSuccess(activeThreadId, activeTurnId, "mcp approval accepted safely");
      } else {
        const error = { message: `unexpected MCP approval action: ${String(action)}`, codexErrorInfo: "Other" };
        send({
          method: "turn/completed",
          params: {
            threadId: activeThreadId,
            turn: { id: activeTurnId, status: "failed", error, items: [] },
          },
        });
      }
      return;
    }

    const decision = message.result?.decision;
    if (scenario === "extension-mcp-install-shell-verification") {
      if (decision === "decline") {
        send({
          method: "turn/completed",
          params: {
            threadId: activeThreadId,
            turn: {
              id: activeTurnId,
              status: "failed",
              error: {
                message: "command verification declined",
                codexErrorInfo: "Other",
              },
              items: [],
            },
          },
        });
      } else {
        const error = {
          message: `unexpected extension verification shell decision: ${String(decision)}`,
          codexErrorInfo: "Other",
        };
        send({
          method: "turn/completed",
          params: {
            threadId: activeThreadId,
            turn: { id: activeTurnId, status: "failed", error, items: [] },
          },
        });
      }
      return;
    }
    if (scenario === "gui-shell-bypass") {
      if (decision === "decline") {
        sendSuccess(activeThreadId, activeTurnId, "gui shell bypass declined safely");
      } else {
        const error = { message: `unexpected GUI shell bypass decision: ${String(decision)}`, codexErrorInfo: "Other" };
        send({
          method: "turn/completed",
          params: {
            threadId: activeThreadId,
            turn: { id: activeTurnId, status: "failed", error, items: [] },
          },
        });
      }
      return;
    }

    if (decision === "decline") {
      sendSuccess(activeThreadId, activeTurnId, "approval declined safely");
    } else if (decision === "accept") {
      sendSuccess(activeThreadId, activeTurnId, "approval accepted safely");
    } else if (decision === "acceptForSession") {
      sendSuccess(activeThreadId, activeTurnId, "approval session accepted safely");
    } else {
      const error = { message: `unexpected approval decision: ${String(decision)}`, codexErrorInfo: "Other" };
      send({
        method: "turn/completed",
        params: {
          threadId: activeThreadId,
          turn: { id: activeTurnId, status: "failed", error, items: [] },
        },
      });
    }
    return;
  }

  if (typeof message.id === "number") {
    send({ id: message.id, error: { code: -32601, message: `unknown method ${String(message.method)}` } });
  }
});

process.on("SIGTERM", () => process.exit(0));
