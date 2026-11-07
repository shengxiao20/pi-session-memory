import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { getSessionMemoryConfig, type SessionMemoryConfig } from "../settings/config.ts";

export const CONFIG_SUMMARY_PREFIX = "Config · ";

/** Describe configured switches and relevant environment inputs in two lines, never credential or path values. */
export function formatConfigSummary(config: SessionMemoryConfig, env: NodeJS.ProcessEnv = process.env): string {
  const { jevConnection: connection } = config;
  const key = connection.apiKeyEnv === undefined
    ? "API key=local-placeholder"
    : `${connection.apiKeyEnv}=${_envState(env[connection.apiKeyEnv])}`;
  const host = `${_envState(env.OLLAMA_HOST)}${connection.manageOllama ? " (managed override)" : ""}`;
  return `${CONFIG_SUMMARY_PREFIX}Jev=${_switch(config.jevEnable)} (${config.model.replace(/\s+/g, " ")}) · Obsidian=${_switch(config.obsidianExportEnabled)} · manageOllama=${_switch(connection.manageOllama)} · limit=${config.recallLimit}\nEnv · MEMORY_DB_PATH=${_envState(env.MEMORY_DB_PATH)} · ${key} · OLLAMA_HOST=${host}`;
}

/** Show only settings used by private consultation tools; never expose paths. */
export function formatConsultationSummary(config: SessionMemoryConfig): string {
  return `${CONFIG_SUMMARY_PREFIX}Discussion=${_switch(config.enableDiscussion === true)} (recall only; main tools unchanged) · timeoutMs=${config.consultation?.timeoutMs ?? "not configured"}\nKnowledge · configured=on · Obsidian=${_switch(config.obsidianExportEnabled)} · output=draft OKF v0.2 (chat = saved file)`;
}

/** Add one invocation-time configuration snapshot to every tool result and progress update without changing evidence details. */
export function withConfigSummary<TParams extends TSchema, TDetails, TState>(tool: ToolDefinition<TParams, TDetails, TState>): ToolDefinition<TParams, TDetails, TState> {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate, ctx) {
      const config = getSessionMemoryConfig();
      const consultationTool = ["follow_up_session", "finish_session_consultation", "cancel_session_consultation", "finish_memory_recall"].includes(tool.name);
      const summary = consultationTool || (tool.name === "recall_memory" && config.enableDiscussion === true)
        ? formatConsultationSummary(config)
        : formatConfigSummary(config);
      const result = await tool.execute(id, params, signal, onUpdate && ((update) => onUpdate(_appendSummary(update, summary))), ctx);
      return _appendSummary(result, summary);
    },
  };
}

function _appendSummary<TDetails>(result: AgentToolResult<TDetails>, summary: string): AgentToolResult<TDetails> {
  return { ...result, content: [...result.content, { type: "text", text: summary }] };
}

function _switch(enabled: boolean): string { return enabled ? "on" : "off"; }
function _envState(value: string | undefined): string { return value?.trim() ? "set" : "unset"; }
