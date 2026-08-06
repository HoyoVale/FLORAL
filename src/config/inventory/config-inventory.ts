import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  access,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ConfigClassification =
  | "floral-owned"
  | "upstream-managed"
  | "upstream-passthrough"
  | "observed-only"
  | "locked";

export interface EnvironmentKeyPolicy {
  component: string;
  classification: ConfigClassification;
}

export interface ConfigCatalogGroup {
  id: string;
  classification: ConfigClassification;
  coverage: string;
  knownKeys: string[];
  futureKeys?: string[] | undefined;
  notes?: string | undefined;
}

export interface ConfigCatalogComponent {
  id: string;
  displayName: string;
  integrationStatus: string;
  versionSource: string;
  officialSources: string[];
  groups: ConfigCatalogGroup[];
  runtimeIntrospection: string[];
}

export interface HardcodedConfigDecision {
  id: string;
  component: string;
  classification: ConfigClassification;
  file: string;
  needle: string;
  risk: string;
}

export interface UpstreamConfigCatalog {
  schemaVersion: number;
  reviewedAt: string;
  purpose: string;
  classifications: ConfigClassification[];
  components: ConfigCatalogComponent[];
  environmentKeyPolicies: Record<string, EnvironmentKeyPolicy>;
  hardcodedDecisions: HardcodedConfigDecision[];
}

export interface ExplicitEnvironmentEntry {
  key: string;
  component?: string | undefined;
  classification?: ConfigClassification | undefined;
  secret: boolean;
  documented: boolean;
}

export interface ExplicitEnvironmentInventory {
  entries: ExplicitEnvironmentEntry[];
  schemaKeys: string[];
  exampleKeys: string[];
  secretKeys: string[];
  schemaOnlyKeys: string[];
  exampleOnlyKeys: string[];
}

export interface HardcodedDecisionObservation extends HardcodedConfigDecision {
  evidenceFound: boolean;
}

export interface QqSdkDeclarationObservation {
  packageRoot?: string | undefined;
  packageVersion?: string | undefined;
  declarationFileCount: number;
  exportedSymbols: string[];
  configLikeSymbols: string[];
  status: "observed" | "not-installed" | "error";
  errorType?: string | undefined;
}

export interface CommandObservation {
  command: string;
  available: boolean;
  version?: string | undefined;
  errorType?: string | undefined;
}

export interface RuntimeConfigObservations {
  codex: CommandObservation;
  peekaboo: CommandObservation;
  qqSdk: QqSdkDeclarationObservation;
}

export interface RepositoryConfigObservation {
  packageName: string;
  packageVersion: string;
  dependencyVersions: Record<string, string>;
  searxngImage?: string | undefined;
  searxngImageDigest?: string | undefined;
  searxngSettingsTopLevelKeys: string[];
}

export interface ConfigurationInventoryIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface ConfigurationInventory {
  schemaVersion: 1;
  generatedAt: string;
  catalogReviewedAt: string;
  repository: RepositoryConfigObservation;
  explicitEnvironment: ExplicitEnvironmentInventory;
  hardcodedDecisions: HardcodedDecisionObservation[];
  components: ConfigCatalogComponent[];
  runtime: RuntimeConfigObservations;
  issues: ConfigurationInventoryIssue[];
  sourceFingerprint: string;
  runtimeFingerprint: string;
}

export interface BuildConfigurationInventoryOptions {
  repositoryRoot: string;
  includeRuntimeProbes?: boolean | undefined;
  codexCommand?: string | undefined;
  peekabooCommand?: string | undefined;
  now?: Date | undefined;
}

export async function buildConfigurationInventory(
  options: BuildConfigurationInventoryOptions,
): Promise<ConfigurationInventory> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const catalog = await loadUpstreamConfigCatalog(repositoryRoot);
  const packageJson = await readJsonFile<{
    name?: unknown;
    version?: unknown;
    dependencies?: unknown;
    devDependencies?: unknown;
  }>(join(repositoryRoot, "package.json"));
  const envSource = await readFile(join(repositoryRoot, "src/config/env.ts"), "utf8");
  const envExample = await readFile(join(repositoryRoot, ".env.example"), "utf8");
  const composeSource = await readFile(join(repositoryRoot, "infra/searxng/compose.yaml"), "utf8");
  const searxngSettings = await readFile(
    join(repositoryRoot, "infra/searxng/settings.template.yml"),
    "utf8",
  );

  const schemaKeys = extractEnvironmentSchemaKeys(envSource);
  const exampleKeys = extractEnvironmentExampleKeys(envExample);
  const explicitEnvironment: ExplicitEnvironmentInventory = {
    entries: schemaKeys.map((key) => {
      const policy = catalog.environmentKeyPolicies[key];
      return {
        key,
        ...(policy ? {
          component: policy.component,
          classification: policy.classification,
        } : {}),
        secret: isSecretKey(key),
        documented: exampleKeys.includes(key),
      };
    }),
    schemaKeys,
    exampleKeys,
    secretKeys: schemaKeys.filter(isSecretKey),
    schemaOnlyKeys: difference(schemaKeys, exampleKeys),
    exampleOnlyKeys: difference(exampleKeys, schemaKeys),
  };

  const hardcodedDecisions = await Promise.all(
    catalog.hardcodedDecisions.map(async (decision) => ({
      ...decision,
      evidenceFound: await fileContains(
        join(repositoryRoot, decision.file),
        decision.needle,
      ),
    })),
  );

  const dependencyVersions = {
    ...readStringRecord(packageJson.dependencies),
    ...readStringRecord(packageJson.devDependencies),
  };
  const image = matchFirst(composeSource, /^\s*image:\s*(\S+)\s*$/m);
  const imageDigest = image?.match(/@sha256:([a-f0-9]{64})$/)?.[1];

  const repository: RepositoryConfigObservation = {
    packageName: readRequiredString(packageJson.name, "package.json name"),
    packageVersion: readRequiredString(packageJson.version, "package.json version"),
    dependencyVersions,
    ...(image ? { searxngImage: image } : {}),
    ...(imageDigest ? { searxngImageDigest: imageDigest } : {}),
    searxngSettingsTopLevelKeys: extractYamlTopLevelKeys(searxngSettings),
  };

  const includeRuntimeProbes = options.includeRuntimeProbes ?? true;
  const runtime = includeRuntimeProbes
    ? await observeRuntime({
        repositoryRoot,
        codexCommand: options.codexCommand ?? "codex",
        peekabooCommand: options.peekabooCommand ?? "peekaboo",
      })
    : emptyRuntimeObservations(
        options.codexCommand ?? "codex",
        options.peekabooCommand ?? "peekaboo",
      );

  const issues = validateInventory({
    catalog,
    explicitEnvironment,
    hardcodedDecisions,
    repository,
    runtime,
  });

  const sourceFingerprint = fingerprint({
    catalog,
    repository,
    explicitEnvironment,
    hardcodedDecisions,
  });
  const runtimeFingerprint = fingerprint({
    sourceFingerprint,
    runtime,
  });

  return {
    schemaVersion: 1,
    generatedAt: (options.now ?? new Date()).toISOString(),
    catalogReviewedAt: catalog.reviewedAt,
    repository,
    explicitEnvironment,
    hardcodedDecisions,
    components: catalog.components,
    runtime,
    issues,
    sourceFingerprint,
    runtimeFingerprint,
  };
}

export async function loadUpstreamConfigCatalog(
  repositoryRoot: string,
): Promise<UpstreamConfigCatalog> {
  const path = join(
    resolve(repositoryRoot),
    "config/catalog/upstream-config-catalog.json",
  );
  const value = await readJsonFile<unknown>(path);
  return parseCatalog(value);
}

export function extractEnvironmentSchemaKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const match of source.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)) {
    const key = match[1];
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

export function extractEnvironmentExampleKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const match of source.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) {
    const key = match[1];
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

export function extractYamlTopLevelKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const match of source.matchAll(/^([a-zA-Z_][a-zA-Z0-9_-]*):(?:\s|$)/gm)) {
    const key = match[1];
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

export function renderConfigurationInventory(
  inventory: ConfigurationInventory,
): string {
  const errors = inventory.issues.filter((issue) => issue.severity === "error");
  const warnings = inventory.issues.filter((issue) => issue.severity === "warning");
  const active = inventory.components.filter((component) =>
    component.integrationStatus.startsWith("active")
  );
  const planned = inventory.components.filter((component) =>
    component.integrationStatus === "planned"
  );

  const lines = [
    `config.inventory.schema=${inventory.schemaVersion}`,
    `config.inventory.catalog_reviewed_at=${inventory.catalogReviewedAt}`,
    `config.inventory.source_fingerprint=${inventory.sourceFingerprint}`,
    `config.inventory.runtime_fingerprint=${inventory.runtimeFingerprint}`,
    `config.inventory.env_schema_keys=${inventory.explicitEnvironment.schemaKeys.length}`,
    `config.inventory.env_example_keys=${inventory.explicitEnvironment.exampleKeys.length}`,
    `config.inventory.secret_key_names=${inventory.explicitEnvironment.secretKeys.length}`,
    `config.inventory.env_locked=${inventory.explicitEnvironment.entries.filter((entry) => entry.classification === "locked").length}`,
    `config.inventory.env_passthrough=${inventory.explicitEnvironment.entries.filter((entry) => entry.classification === "upstream-passthrough").length}`,
    `config.inventory.hardcoded_decisions=${inventory.hardcodedDecisions.length}`,
    `config.inventory.components=${inventory.components.length}`,
    `config.inventory.components_active=${active.map((item) => item.id).join(",")}`,
    `config.inventory.components_planned=${planned.map((item) => item.id).join(",")}`,
    `config.inventory.searxng_image=${inventory.repository.searxngImage ?? "unknown"}`,
    `config.inventory.codex.available=${String(inventory.runtime.codex.available)}`,
    `config.inventory.codex.version=${inventory.runtime.codex.version ?? "unavailable"}`,
    `config.inventory.peekaboo.available=${String(inventory.runtime.peekaboo.available)}`,
    `config.inventory.peekaboo.version=${inventory.runtime.peekaboo.version ?? "unavailable"}`,
    `config.inventory.qq_sdk.status=${inventory.runtime.qqSdk.status}`,
    `config.inventory.qq_sdk.version=${inventory.runtime.qqSdk.packageVersion ?? inventory.repository.dependencyVersions["@tencent-connect/qqbot-nodejs"] ?? "unknown"}`,
    `config.inventory.qq_sdk.declaration_files=${inventory.runtime.qqSdk.declarationFileCount}`,
    `config.inventory.errors=${errors.length}`,
    `config.inventory.warnings=${warnings.length}`,
  ];

  for (const issue of inventory.issues) {
    lines.push(
      `config.inventory.issue.${issue.severity}=${issue.code}:${sanitizeLine(issue.message)}`,
    );
  }
  lines.push(`config.inventory=${errors.length === 0 ? "ok" : "invalid"}`);
  return `${lines.join("\n")}\n`;
}

export function inventoryHasErrors(inventory: ConfigurationInventory): boolean {
  return inventory.issues.some((issue) => issue.severity === "error");
}

interface ValidationInput {
  catalog: UpstreamConfigCatalog;
  explicitEnvironment: ExplicitEnvironmentInventory;
  hardcodedDecisions: HardcodedDecisionObservation[];
  repository: RepositoryConfigObservation;
  runtime: RuntimeConfigObservations;
}

function validateInventory(input: ValidationInput): ConfigurationInventoryIssue[] {
  const issues: ConfigurationInventoryIssue[] = [];
  for (const key of input.explicitEnvironment.schemaOnlyKeys) {
    issues.push({
      severity: "error",
      code: "env-schema-key-undocumented",
      message: `${key} exists in src/config/env.ts but not .env.example`,
    });
  }
  for (const key of input.explicitEnvironment.exampleOnlyKeys) {
    issues.push({
      severity: "error",
      code: "env-example-key-unparsed",
      message: `${key} exists in .env.example but not src/config/env.ts`,
    });
  }
  const policyKeys = Object.keys(input.catalog.environmentKeyPolicies).sort();
  for (const key of difference(input.explicitEnvironment.schemaKeys, policyKeys)) {
    issues.push({
      severity: "error",
      code: "env-key-policy-missing",
      message: `${key} has no ownership classification in the upstream catalog`,
    });
  }
  for (const key of difference(policyKeys, input.explicitEnvironment.schemaKeys)) {
    issues.push({
      severity: "error",
      code: "env-key-policy-stale",
      message: `${key} is classified in the catalog but no longer exists in src/config/env.ts`,
    });
  }
  for (const decision of input.hardcodedDecisions) {
    if (!decision.evidenceFound) {
      issues.push({
        severity: "error",
        code: "hardcoded-decision-evidence-missing",
        message: `${decision.id} no longer matches ${decision.file}`,
      });
    }
  }

  const componentIds = new Set<string>();
  for (const component of input.catalog.components) {
    if (componentIds.has(component.id)) {
      issues.push({
        severity: "error",
        code: "duplicate-component-id",
        message: `Duplicate component catalog ID: ${component.id}`,
      });
    }
    componentIds.add(component.id);
    if (component.officialSources.length === 0) {
      issues.push({
        severity: "error",
        code: "component-source-missing",
        message: `${component.id} has no configuration source`,
      });
    }
  }
  for (const [key, policy] of Object.entries(input.catalog.environmentKeyPolicies)) {
    if (!componentIds.has(policy.component)) {
      issues.push({
        severity: "error",
        code: "env-policy-component-missing",
        message: `${key} references unknown component ${policy.component}`,
      });
    }
  }
  for (const decision of input.catalog.hardcodedDecisions) {
    if (!componentIds.has(decision.component)) {
      issues.push({
        severity: "error",
        code: "decision-component-missing",
        message: `${decision.id} references unknown component ${decision.component}`,
      });
    }
  }

  if (!input.repository.searxngImageDigest) {
    issues.push({
      severity: "error",
      code: "searxng-image-not-pinned",
      message: "infra/searxng/compose.yaml must pin a sha256 image digest",
    });
  }
  if (input.runtime.qqSdk.status !== "observed") {
    issues.push({
      severity: "warning",
      code: "qq-sdk-types-not-observed",
      message: "Run after pnpm install to inventory the installed QQ SDK declaration surface",
    });
  }
  if (!input.runtime.codex.available) {
    issues.push({
      severity: "warning",
      code: "codex-version-not-observed",
      message: "Codex was not available for a local version probe",
    });
  }
  if (!input.runtime.peekaboo.available) {
    issues.push({
      severity: "warning",
      code: "peekaboo-version-not-observed",
      message: "Peekaboo was not available for a local version probe",
    });
  }
  if (input.repository.searxngSettingsTopLevelKeys.includes("use_default_settings")) {
    issues.push({
      severity: "warning",
      code: "searxng-effective-defaults-not-frozen",
      message: "SearXNG inherits upstream defaults; effective engines and plugins require runtime capture",
    });
  }
  return issues;
}

async function observeRuntime(options: {
  repositoryRoot: string;
  codexCommand: string;
  peekabooCommand: string;
}): Promise<RuntimeConfigObservations> {
  const [codex, peekaboo, qqSdk] = await Promise.all([
    observeCommand(options.codexCommand, ["--version"]),
    observeCommand(options.peekabooCommand, ["--version"]),
    observeQqSdk(options.repositoryRoot),
  ]);
  return { codex, peekaboo, qqSdk };
}

function emptyRuntimeObservations(
  codexCommand: string,
  peekabooCommand: string,
): RuntimeConfigObservations {
  return {
    codex: {
      command: codexCommand,
      available: false,
      errorType: "probe-disabled",
    },
    peekaboo: {
      command: peekabooCommand,
      available: false,
      errorType: "probe-disabled",
    },
    qqSdk: {
      declarationFileCount: 0,
      exportedSymbols: [],
      configLikeSymbols: [],
      status: "not-installed",
      errorType: "probe-disabled",
    },
  };
}

async function observeCommand(
  command: string,
  args: string[],
): Promise<CommandObservation> {
  try {
    const result = await execFileAsync(command, args, {
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    const version = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/)[0];
    return {
      command,
      available: true,
      ...(version ? { version } : {}),
    };
  } catch (error) {
    return {
      command,
      available: false,
      errorType: safeErrorType(error),
    };
  }
}

async function observeQqSdk(repositoryRoot: string): Promise<QqSdkDeclarationObservation> {
  try {
    const packageRoot = await resolveQqSdkPackageRoot(repositoryRoot);
    if (!packageRoot) {
      return {
        declarationFileCount: 0,
        exportedSymbols: [],
        configLikeSymbols: [],
        status: "not-installed",
        errorType: "PackageRootNotFound",
      };
    }
    const packageJson = await readJsonFile<{ version?: unknown }>(
      join(packageRoot, "package.json"),
    );
    const declarationFiles = await findFiles(packageRoot, (path) => path.endsWith(".d.ts"), 8);
    const exportedSymbols = new Set<string>();
    for (const file of declarationFiles) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(
        /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type|enum|const|function)\s+([A-Za-z_$][\w$]*)/g,
      )) {
        const symbol = match[1];
        if (symbol) exportedSymbols.add(symbol);
      }
      for (const match of source.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
        for (const raw of (match[1] ?? "").split(",")) {
          const symbol = raw.trim().split(/\s+as\s+/i).at(-1);
          if (symbol && /^[A-Za-z_$][\w$]*$/.test(symbol)) exportedSymbols.add(symbol);
        }
      }
    }
    const symbols = [...exportedSymbols].sort();
    const packageVersion = readOptionalString(packageJson.version);
    return {
      packageRoot,
      ...(packageVersion ? { packageVersion } : {}),
      declarationFileCount: declarationFiles.length,
      exportedSymbols: symbols.slice(0, 300),
      configLikeSymbols: symbols.filter((symbol) =>
        /(config|options|settings|gateway|session|retry|client|transport|event|message|media|stream)/i.test(symbol)
      ).slice(0, 200),
      status: "observed",
    };
  } catch (error) {
    const type = safeErrorType(error);
    return {
      declarationFileCount: 0,
      exportedSymbols: [],
      configLikeSymbols: [],
      status: type === "MODULE_NOT_FOUND" ? "not-installed" : "error",
      errorType: type,
    };
  }
}


async function resolveQqSdkPackageRoot(repositoryRoot: string): Promise<string | undefined> {
  const direct = join(
    repositoryRoot,
    "node_modules",
    "@tencent-connect",
    "qqbot-nodejs",
  );
  try {
    await access(join(direct, "package.json"));
    return await realpath(direct).catch(() => direct);
  } catch {
    // Fall back to Node resolution for non-standard package layouts.
  }
  try {
    const requireFromProject = createRequire(join(repositoryRoot, "package.json"));
    const entry = requireFromProject.resolve("@tencent-connect/qqbot-nodejs");
    return await findPackageRoot(dirname(entry));
  } catch {
    return undefined;
  }
}

async function findPackageRoot(start: string): Promise<string | undefined> {
  let current = resolve(start);
  while (true) {
    try {
      const packageJson = await readJsonFile<{ name?: unknown }>(join(current, "package.json"));
      if (packageJson.name === "@tencent-connect/qqbot-nodejs") return current;
    } catch {
      // Keep walking toward the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function findFiles(
  root: string,
  predicate: (path: string) => boolean,
  maxDepth: number,
): Promise<string[]> {
  const results: string[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
      } else if (entry.isFile() && predicate(path)) {
        results.push(path);
      }
    }
  }
  await visit(root, 0);
  return results.sort();
}

function parseCatalog(value: unknown): UpstreamConfigCatalog {
  const record = asRecord(value, "catalog");
  const schemaVersion = readNumber(record.schemaVersion, "catalog.schemaVersion");
  if (schemaVersion !== 1) {
    throw new Error(`Unsupported upstream config catalog schema: ${schemaVersion}`);
  }
  const classifications = readStringArray(
    record.classifications,
    "catalog.classifications",
  ) as ConfigClassification[];
  const allowed = new Set<ConfigClassification>([
    "floral-owned",
    "upstream-managed",
    "upstream-passthrough",
    "observed-only",
    "locked",
  ]);
  for (const classification of classifications) {
    if (!allowed.has(classification)) {
      throw new Error(`Unknown catalog classification: ${classification}`);
    }
  }
  const components = readArray(record.components, "catalog.components").map(
    (item, index) => parseComponent(item, `catalog.components[${index}]`, allowed),
  );
  const environmentPoliciesRecord = asRecord(
    record.environmentKeyPolicies,
    "catalog.environmentKeyPolicies",
  );
  const environmentKeyPolicies: Record<string, EnvironmentKeyPolicy> = {};
  for (const [key, rawPolicy] of Object.entries(environmentPoliciesRecord)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment policy key: ${key}`);
    }
    const policyPath = `catalog.environmentKeyPolicies.${key}`;
    const policy = asRecord(rawPolicy, policyPath);
    const classification = readString(
      policy.classification,
      `${policyPath}.classification`,
    ) as ConfigClassification;
    if (!allowed.has(classification)) {
      throw new Error(`Unknown classification at ${policyPath}: ${classification}`);
    }
    environmentKeyPolicies[key] = {
      component: readString(policy.component, `${policyPath}.component`),
      classification,
    };
  }
  const hardcodedDecisions = readArray(
    record.hardcodedDecisions,
    "catalog.hardcodedDecisions",
  ).map((item, index) =>
    parseDecision(item, `catalog.hardcodedDecisions[${index}]`, allowed)
  );
  return {
    schemaVersion,
    reviewedAt: readString(record.reviewedAt, "catalog.reviewedAt"),
    purpose: readString(record.purpose, "catalog.purpose"),
    classifications,
    components,
    environmentKeyPolicies,
    hardcodedDecisions,
  };
}

function parseComponent(
  value: unknown,
  path: string,
  allowed: Set<ConfigClassification>,
): ConfigCatalogComponent {
  const record = asRecord(value, path);
  return {
    id: readString(record.id, `${path}.id`),
    displayName: readString(record.displayName, `${path}.displayName`),
    integrationStatus: readString(record.integrationStatus, `${path}.integrationStatus`),
    versionSource: readString(record.versionSource, `${path}.versionSource`),
    officialSources: readStringArray(record.officialSources, `${path}.officialSources`),
    groups: readArray(record.groups, `${path}.groups`).map((item, index) => {
      const groupPath = `${path}.groups[${index}]`;
      const group = asRecord(item, groupPath);
      const classification = readString(
        group.classification,
        `${groupPath}.classification`,
      ) as ConfigClassification;
      if (!allowed.has(classification)) {
        throw new Error(`Unknown classification at ${groupPath}: ${classification}`);
      }
      const futureKeys = group.futureKeys === undefined
        ? undefined
        : readStringArray(group.futureKeys, `${groupPath}.futureKeys`);
      const notes = group.notes === undefined
        ? undefined
        : readString(group.notes, `${groupPath}.notes`);
      return {
        id: readString(group.id, `${groupPath}.id`),
        classification,
        coverage: readString(group.coverage, `${groupPath}.coverage`),
        knownKeys: readStringArray(group.knownKeys, `${groupPath}.knownKeys`),
        ...(futureKeys ? { futureKeys } : {}),
        ...(notes ? { notes } : {}),
      };
    }),
    runtimeIntrospection: readStringArray(
      record.runtimeIntrospection,
      `${path}.runtimeIntrospection`,
    ),
  };
}

function parseDecision(
  value: unknown,
  path: string,
  allowed: Set<ConfigClassification>,
): HardcodedConfigDecision {
  const record = asRecord(value, path);
  const classification = readString(
    record.classification,
    `${path}.classification`,
  ) as ConfigClassification;
  if (!allowed.has(classification)) {
    throw new Error(`Unknown classification at ${path}: ${classification}`);
  }
  return {
    id: readString(record.id, `${path}.id`),
    component: readString(record.component, `${path}.component`),
    classification,
    file: readString(record.file, `${path}.file`),
    needle: readString(record.needle, `${path}.needle`),
    risk: readString(record.risk, `${path}.risk`),
  };
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function fileContains(path: string, needle: string): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")).includes(needle);
  } catch {
    return false;
  }
}

function difference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function isSecretKey(key: string): boolean {
  return /(API_KEY|APP_SECRET|SECRET|TOKEN|PAIRING_CODE|PASSWORD|CREDENTIAL)/.test(key);
}

function matchFirst(source: string, pattern: RegExp): string | undefined {
  return source.match(pattern)?.[1];
}

function readStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    ),
  );
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sanitizeLine(value: string): string {
  return value.replace(/[\r\n=]/g, " ").trim();
}

function safeErrorType(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  if (error instanceof Error && error.name) return error.name;
  return "Error";
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function readStringArray(value: unknown, path: string): string[] {
  return readArray(value, path).map((item, index) =>
    readString(item, `${path}[${index}]`)
  );
}

function readString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function readRequiredString(value: unknown, path: string): string {
  return readString(value, path);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}
