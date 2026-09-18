/** Static user-facing overview displayed by the pi-session-memory helper command. */
export const SESSION_MEMORY_HELP = `# pi-session-memory

本插件将 Pi、Claude Code 和 Codex 的本地历史索引到 SQLite，供按需跨会话检索。
This extension indexes local Pi, Claude Code, and Codex history for on-demand cross-session retrieval.

- **检索以前的讨论 / Recall past discussions**
  - 直接询问“我们之前讨论过 xxx 的什么方案？”或 “What did we decide about xxx?”
  - Pi 只在需要时搜索本地历史；匹配摘要不足时才读取最小必要会话范围。
  - 历史不会自动注入模型上下文，也不会保存 Agent 生成的记忆摘要。

- **迁移项目会话 / Migrate project sessions**
  - 只有希望通过 \`/resume\` 在 Pi 原生继续 Claude Code 或 Codex 项目会话时，才运行迁移。
  - 使用 \`/project-claude-session-migration\` 或 \`/project-session-migration\`。
  - 每个迁移源会话生成一个独立 Pi session。

- **本地存储 / Local storage**
  - \`/memory-search <query>\` 搜索原始本地 transcript。
  - \`/memory-backfill\` 明确要求时全量重扫历史。
  - \`/memory-status\` 显示已索引的 session 和 turn 总数。
  - 持久规则、偏好和项目指令应写在 \`AGENTS.md\`。

历史仅保存在本机 SQLite。导入错误按来源文件隔离，不会阻止其他 Pi、Claude Code 或 Codex 会话被索引。
History stays in local SQLite; an import error in one source file does not block other sessions.`;
