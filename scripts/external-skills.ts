import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import {
  CURATED_EXTERNAL_SKILLS,
  validateGitRef,
} from "../src/skills/external-skill-registry.js";
import {
  ExternalSkillManager,
  type ExternalSkillMutationAction,
} from "../src/skills/external-skill-manager.js";

loadProjectEnv();

const repositoryRoot = process.cwd();
const authority = await resolveConfigurationAuthority({
  repositoryRoot,
  environment: process.env,
});
const manager = new ExternalSkillManager({
  repositoryRoot,
  dataDir: authority.effective.floral.data_dir,
});

const [command = "list", idValue, ...rest] = process.argv.slice(2);

switch (command) {
  case "list":
    await printList();
    break;
  case "doctor":
    await printDoctor();
    break;
  case "install":
  case "update":
  case "enable":
  case "disable":
  case "remove":
    await mutate(
      command,
      requireCatalogId(idValue),
      parseRef(rest, command),
    );
    break;
  default:
    usage(`Unknown command: ${command}`);
}

async function printList(): Promise<void> {
  const packages = await manager.list();
  for (const entry of packages) {
    if (!entry.installed) {
      process.stdout.write(
        `${entry.id}\tinstalled=false\tsource=${entry.repository}\n`,
      );
      continue;
    }
    process.stdout.write([
      entry.id,
      "installed=true",
      `enabled=${String(entry.enabled)}`,
      `ref=${entry.ref ?? ""}`,
      `commit=${entry.commit ?? ""}`,
      `source=${entry.repository}`,
    ].join("\t") + "\n");
  }
}

async function printDoctor(): Promise<void> {
  const roots = await manager.enabledRoots(true);
  process.stdout.write(
    `external_skills.status=ok\nexternal_skills.enabled_roots=${String(roots.length)}\n`,
  );
  for (const root of roots) {
    process.stdout.write(`external_skills.root=${root}\n`);
  }
}

async function mutate(
  action: ExternalSkillMutationAction,
  id: keyof typeof CURATED_EXTERNAL_SKILLS,
  ref: string | undefined,
): Promise<void> {
  const result = await manager.manage({
    action,
    id,
    ...(ref ? { ref } : {}),
  });
  process.stdout.write(`${result.message.replace(/\n/gu, " ")} restart_required=true\n`);
  process.stdout.write(
    "note=Third-party Skills are untrusted instructions. FLORAL shares only validated Skill roots; normal sandbox and approval policy still apply.\n",
  );
}

function requireCatalogId(
  value: string | undefined,
): keyof typeof CURATED_EXTERNAL_SKILLS {
  if (!value || !(value in CURATED_EXTERNAL_SKILLS)) {
    usage(
      `Unknown or missing external Skill id: ${String(value ?? "")}`,
    );
  }
  return value as keyof typeof CURATED_EXTERNAL_SKILLS;
}

function parseRef(
  args: string[],
  action: ExternalSkillMutationAction,
): string | undefined {
  if (action !== "install" && action !== "update") {
    if (args.length > 0) {
      usage(`${action} does not accept --ref`);
    }
    return undefined;
  }
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--ref" || !args[1]) {
    usage("Expected optional --ref <git-ref>");
  }
  return validateGitRef(args[1]);
}

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write([
    "Usage:",
    "  pnpm skills:external list",
    "  pnpm skills:external doctor",
    "  pnpm skills:external install superpowers [--ref main]",
    "  pnpm skills:external update superpowers [--ref main]",
    "  pnpm skills:external enable superpowers",
    "  pnpm skills:external disable superpowers",
    "  pnpm skills:external remove superpowers",
  ].join("\n") + "\n");
  process.exitCode = 2;
  throw new Error("Invalid external Skill command");
}
