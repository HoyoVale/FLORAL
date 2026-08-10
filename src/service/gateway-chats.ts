import {
  supportsAgentThreadManagement,
  type AgentRuntime,
  type AgentThreadSummary,
} from "../core/contracts.js";
import { formatThreadPreview } from "./gateway-presentation.js";

export async function listGatewayChats(input: {
  agent: AgentRuntime;
  cwd: string;
  projectName: string;
  activeThreadId?: string | undefined;
}): Promise<{ entries: AgentThreadSummary[]; text: string }> {
  if (!supportsAgentThreadManagement(input.agent)) {
    throw new Error("thread-list-unavailable");
  }
  const entries = await input.agent.listThreads({ cwd: input.cwd, limit: 20 });
  const lines = [`项目 ${input.projectName} 的会话：`];
  if (entries.length === 0) {
    lines.push("（暂无 Codex 会话；下一条普通消息会创建第一个会话）");
  } else {
    entries.forEach((entry, index) => {
      const marker = entry.id === input.activeThreadId ? " ← 当前" : "";
      lines.push(`${String(index + 1)}. ${formatThreadPreview(entry.preview)}${marker}`);
    });
  }
  lines.push("", "使用 /chat <序号> 切换；/chat new 新建；/chat archive <序号> 归档（owner）。");
  return { entries, text: lines.join("\n") };
}
