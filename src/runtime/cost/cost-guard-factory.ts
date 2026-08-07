import type { DeepSeekCostGuardPolicy } from "./deepseek-cost-guard.js";
import { DeepSeekCostGuard } from "./deepseek-cost-guard.js";
import type { ResolvedConfigurationAuthority } from "../../config/federation/config-authority.js";
import { resolveConfigurationAuthority } from "../../config/federation/config-authority.js";

export function createDeepSeekCostGuardFromAuthority(
  repositoryRoot: string,
  authority: ResolvedConfigurationAuthority,
): DeepSeekCostGuard {
  return new DeepSeekCostGuard({
    repositoryRoot,
    policy: authority.effective.runtime.cost_guard as DeepSeekCostGuardPolicy,
  });
}

export async function createProjectDeepSeekCostGuard(
  repositoryRoot = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DeepSeekCostGuard> {
  const authority = await resolveConfigurationAuthority({ repositoryRoot, environment });
  return createDeepSeekCostGuardFromAuthority(repositoryRoot, authority);
}
