import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("codex-cli 9.9.9-test\n");
  process.exit(0);
}

if (
  args[0] === "app-server"
  && args[1] === "generate-json-schema"
  && args[2] === "--out"
  && typeof args[3] === "string"
) {
  const output = args[3];
  await mkdir(output, { recursive: true });
  await writeFile(
    `${output}/ClientRequest.json`,
    `${JSON.stringify({
      methods: [
        "thread/list",
        "thread/read",
        "thread/fork",
        "thread/archive",
        "thread/delete",
        "thread/loaded/list",
        "thread/turns/list",
        "config/read",
        "configRequirements/read",
        "thread/memoryMode/set",
        "memory/reset",
        "command/exec",
      ],
      fields: [
        "permissionProfile",
        "activePermissionProfile",
        "request_permissions",
        "auto_review",
        "runtimeWorkspaceRoots",
        "instructionSources",
      ],
    }, null, 2)}\n`,
  );
  await writeFile(
    `${output}/ServerRequest.json`,
    `${JSON.stringify({
      methods: ["item/permissions/requestApproval"],
      decisions: ["acceptForSession"],
    }, null, 2)}\n`,
  );
  process.exit(0);
}

if (args.length === 1 && args[0] === "app-server") {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({
        id: message.id,
        result: {
          userAgent: "fake-codex/9.9.9",
          codexHome: "/secret/fake-codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      });
      continue;
    }
    if (message.method === "initialized") continue;

    if (message.method === "config/read") {
      send({
        id: message.id,
        result: {
          config: {
            approval_policy: "untrusted",
            approvals_reviewer: "user",
            sandbox_mode: "workspace-write",
            do_not_persist: "TOP_SECRET_VALUE",
          },
          origins: {},
        },
      });
      continue;
    }

    if (message.method === "configRequirements/read") {
      send({
        id: message.id,
        result: {
          requirements: {
            allowedApprovalPolicies: [
              "untrusted",
              "on-request",
              "never",
              { granular: {
                sandbox_approval: true,
                rules: true,
                request_permissions: true,
                mcp_elicitations: true,
              } },
            ],
            allowedApprovalsReviewers: ["user", "auto_review"],
            allowedSandboxModes: [
              "read-only",
              "workspace-write",
              "danger-full-access",
            ],
            allowedPermissionProfiles: {
              ":read-only": true,
              ":workspace": true,
              "full-machine": false,
            },
            defaultPermissions: ":workspace",
            allowRemoteControl: false,
            autoReview: { enabled: true },
            network: { managed: true },
            sqliteHome: "/secret/path-that-must-not-be-persisted",
          },
        },
      });
      continue;
    }

    if (message.method === "thread/list") {
      send({
        id: message.id,
        result: {
          data: [{
            id: "thread-secret",
            preview: "DO_NOT_PERSIST_THREAD_CONTENT",
          }],
          nextCursor: null,
        },
      });
      continue;
    }

    if (message.method === "thread/loaded/list") {
      send({
        id: message.id,
        result: { data: ["thread-secret"] },
      });
      continue;
    }

    if (message.id !== undefined) {
      send({
        id: message.id,
        error: {
          code: -32601,
          message: `Method not found: ${String(message.method)}`,
        },
      });
    }
  }
  process.exit(0);
}

process.stderr.write(`unexpected fake Codex invocation: ${JSON.stringify(args)}\n`);
process.exit(2);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
