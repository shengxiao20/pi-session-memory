/** Static user-facing overview displayed by the pi-session-memory helper command. */
export const SESSION_MEMORY_HELP = `# pi-session-memory

你可以直接像正常聊天一样请求使用历史记忆。
You can request history and memory features in natural language.

**跨客户端回忆与记忆 / Cross-client recall and memory**

无论对话来自 Pi、Claude Code 还是 Codex，你都可以直接请求回忆历史或保存、管理长期记忆。
Regardless of whether a conversation came from Pi, Claude Code, or Codex, you can directly recall history and save or manage durable memories.

- **在 Pi 中无缝接续 Claude Code 或 Codex 项目会话 / Seamlessly continue Claude Code or Codex project sessions in Pi**
  - 只有当你明确希望在 Pi 中接续某个项目的 Claude Code 或 Codex 历史工作流时，才建议迁移项目会话。
  - Migrate sessions only when you explicitly want to continue a project's Claude Code or Codex workflow seamlessly in Pi.
  - “请把当前项目以前的 Claude Code 会话迁移成 Pi session。”或“请把当前项目以前的 Codex 会话迁移成 Pi session。”
  - “Convert this project's previous Claude Code sessions into Pi sessions.” or “Convert this project's previous Codex sessions into Pi sessions.”
  - 每个迁移的 session 会成为一个独立的 Pi session；完成后用 \`/resume\` 选择要继续的会话。
  - Each migrated session becomes an independent Pi session; use \`/resume\` to select the one you want to continue.
  - 只迁移记录的工作目录与当前项目一致的会话。
  - Only sessions whose recorded working directory matches the current project are migrated.

- **回忆以前的讨论 / Recall past discussions**
  - “我们之前讨论过 xxx 的什么方案？”、“找一下我以前关于 xxx 的结论。”
  - “What did we decide about xxx?” or “Find our earlier conclusion about the xxx.”
  - 我会检索本地历史；必要时会读取匹配会话的相关上下文。
  - I search local history and, when needed, retrieve relevant context from a matching session.

- **保存长期结论 / Save a durable conclusion**
  - “记住：发布前必须运行集成测试。”或“把刚才的架构决定固定下来。”
  - “Remember that integration tests must run before release.” or “Save the architecture decision we just made.”

- **管理保存的记忆 / Manage saved memories**
  - “列出我保存的记忆”、“确认这条记忆仍然有效”、“用新结论替换旧记忆”，或“忘记那条部署约定。”
  - “List my saved memories,” “confirm this memory is still current,” “replace the old memory with this conclusion,” or “forget that deployment convention.”

- **查看当前存储情况 / Check local storage**
  - “现在已经导入了多少历史记录？”
  - “How much conversation history has been imported?”

历史和记忆均保存在本机 SQLite 中。历史导入会按来源和文件隔离错误：一个不兼容的 Pi、Claude Code 或 Codex 会话不会阻止其他会话被导入。
History and memories stay in local SQLite storage. Import errors are isolated by source and file, so one incompatible Pi, Claude Code, or Codex session does not block other sessions.

随时运行 \`/pi-session-memory-helper\` 再次查看这些使用方式。
Run \`/pi-session-memory-helper\` at any time to view this guide again.`;
