# pi-session-memory（中文）

[English](README.md)

**当前版本：0.7.23**

`pi-session-memory` 是本地优先的跨会话、跨 Agent 对话检索插件。它会将本机 Pi、Claude Code 和 Codex 的 JSONL 对话轮次索引到本地 SQLite；可选地使用本地或远程 System One 决策模型进行语义相关性筛选、将 Claude Code/Codex 会话迁移为 Pi 原生可在 `/resume` 中继续的会话，并将检索结果导出到 Obsidian。

## Install（安装）

```bash
pi install npm:pi-session-memory
```

## What it does / Commands（功能与命令）

- 索引保存在本机 SQLite。默认不上传对话内容；显式启用远程筛选时会发送候选原文片段及完整问题。
- 与历史工作或以往对话相关的问题只需调用一次 `recall_memory`，传入 2–8 个字面主题实体和完整问题。工具内部自动串行执行：先全局搜索所有已索引轮次，再以相同实体匹配存储的会话 CWD 最终目录名，并检索匹配会话。
- 两阶段分别执行原有字面检索和可选 Jev 筛选；项目阶段完成后，仅按全局最终返回的 `turn_id` 移除重复项目轮次。不改变 SQL、排序、数量限制、目录匹配或 Jev 逻辑，不提前排除候选，也不补查。
- Pi 终端的进度与紧凑结果分别显示 Global recall 和 Project recall；展开可读完整原文。独立的 `recall_project_memory` Agent 工具已移除，手动全局/项目搜索菜单保持独立和原有行为。检索不使用当前运行时、当前项目或当前 CWD 作为隐式范围。
- `review_jev_filtered` 用于审查 Jev 筛掉的候选项；`migrate_project_sessions` 可将 Claude Code 和/或 Codex 的匹配项目会话迁移到 Pi；`get_memory_stats` 报告已索引历史总量；`backfill_memory` 仅在明确要求导入、回填或重扫历史时使用。
- 可在配置中启用本地或远程 System One 相关性筛选和 Obsidian 导出。未显式启用 Obsidian 时不会导出。

## Flow and migration compatibility（工作流程与迁移兼容性）

检索会先在 SQLite 中执行字面匹配，再按配置选择是否以 System One 决策模型语义筛选结果。一次调用等待全局检索与筛选完成后才开始项目检索与筛选；项目最终结果随后按全局最终结果的精确轮次 ID 去重。两阶段各自仍受原有 `recallLimit` 限制，去重后不补足数量；Jev 统计描述去重前的筛选，`project.duplicatesRemoved` 单独记录去重数量。项目文本、结构化结果和 Obsidian 导出使用同一份去重结果，启用导出时整次调用写入一篇完整笔记。

迁移只选择其记录的项目 CWD 与当前 Pi 项目 CWD 等价的会话；在 Windows 上，路径分隔符、尾部斜杠和盘符大小写的差异会被视为相同。迁移后的会话会写入当前 Pi 项目 CWD，因此可在该项目的 `/resume` 中看到。

完整的英文配置字段、命令参数、工具使用约束、Obsidian 导出行为和版本更新记录见上方英文文档。

## 调用配置摘要

全部六个 Agent 工具的结果和进度更新都会追加两行调用时配置快照；召回折叠显示也保留完整两行：

```text
Config · Jev=off (nimble) · Obsidian=off · manageOllama=on · limit=20
Env · MEMORY_DB_PATH=unset · API key=local-placeholder · OLLAMA_HOST=unset (managed override)
```

第一行显示配置开关、模型和召回数量限制，不代表运行时已就绪。第二行只显示相关环境变量是否有非空值；配置 `apiKeyEnv` 后，会以变量名及 `set`/`unset` 替换本地占位密钥标签。托管 Ollama 会用连接配置地址覆盖子进程的 `OLLAMA_HOST`；非托管连接不使用此变量。摘要不输出密钥值、数据库/Vault 路径或 endpoint。每次调用重新读取配置，同一次调用的进度与最终结果共用快照。原有结果段落和结构化详情不变，Obsidian 笔记只保留检索证据，不包含运行配置摘要；手动菜单行为不变。

## 对话轮次语义

- Pi 按 `id`/`parentId` 关联消息，支持消息之间的非消息节点。每个有可检索文本的 user entry 对应一条轮次；分支回复归给最近的用户祖先，绝不按文件中最后出现的用户配对。同一用户的多个分支回复按文件顺序聚合，因此索引不是单一活动分支的还原。
- Pi 实时写入和导入共用轮次构建器。重复写入会更新累计回复和工具名，不再忽略后续输出。`turn_index` 是完整会话文件中用户 entry 的零基位置，不是当前分支的位置；纯图片用户占据编号但不形成可检索轮次。
- 无文本回复的用户轮次仍保留，包括中断请求和只有工具调用的回复；Pi 和 Claude 的纯工具调用 assistant 消息保留工具名。
- 解析器版本变更会在下次会话启动时自动重建未变化的 Pi、Claude Code、Codex 文件索引，修正旧配对和编号，不改源文件。升级时旧索引范围可能发生一次变化，应使用新召回结果中的范围。Pi ID 或父链接不合法时报告导入问题并保留该文件的旧索引，不退回线性解析。

## System One 连接配置

配置文件为 `~/.pi/agent/pi-session-memory/config.json`。Ollama、官方 Jev、Qwen Decision API 共用同一客户端和 `.noul` 筛选处理，不做 OpenAI 适配。

- `jevEnable` 默认为 `false`。省略 `jevConnection` 时，保持原有本地 Ollama 行为和默认模型 `nimble`。
- `model` 可填写任意非空决策模型名称，不再限定为三个本地模型。
- `jevConnection.baseURL` 是 API 根地址，SDK 自动追加 `/v1/systemone`，不要填写完整接口地址。
- `jevConnection.manageOllama` 必须明确填写。`true` 仅用于本地 HTTP 根地址（`127.0.0.1`、`localhost` 或 `[::1]`），执行启动、版本检查、拉模型和 `num_ctx` 查询；CLI 通过 `OLLAMA_HOST` 使用同一地址。`false` 不执行任何 Ollama 管理操作，包括独立管理的 Ollama 服务。
- `manageOllama: false` 时，必须显式填写 `model`、`apiKeyEnv` 和正整数 `contextWindow`。`apiKeyEnv` 指向 Pi 进程环境中的密钥变量，缺失或空值直接报错，不把密钥写进配置。`contextWindow` 是输入预算，应不超过模型实际限制；不调用远程模型发现接口。
- 托管 Ollama 的 `apiKeyEnv` 可省略，沿用 `ollama` 占位值；可选 `contextWindow` 只会压低有效预算，不会提高实际 `num_ctx`。

官方 Jev 示例（`4096` 只是预算示例，并非模型最大上下文声明）：

```json
{
  "recallLimit": 20,
  "jevEnable": true,
  "model": "jev-latest",
  "jevConnection": {
    "baseURL": "https://api.typesafe.ai",
    "apiKeyEnv": "TYPESAFE_API_KEY",
    "contextWindow": 4096,
    "manageOllama": false
  }
}
```

使用 Qwen Decision API 时，将 `baseURL` 改为对应地域工作空间的根地址，例如 `https://<WorkspaceId>.ap-southeast-1.maas.aliyuncs.com/compatible-mode`，`model` 改为 `decision-model-preview`，`apiKeyEnv` 改为 `DASHSCOPE_API_KEY`，并在 Pi 的环境中设置匹配地域/工作空间的密钥。这不是普通 Qwen Chat API。参见 [TypeSafe 文档](https://docs.typesafe.ai/api/system-one) 和 [阿里云 Decision API 文档](https://www.alibabacloud.com/help/en/model-studio/decision-model-api)。

修改模型或连接配置后需重新加载插件；不允许在同一运行时切换连接。远程 ready 状态仅表示本地配置和凭证已解析，不代表已联网验证。保留既有 Jev 请求失败/本地启动失败时返回字面检索结果的行为，不自动识别厂商或切换后端；配置错误和缺失密钥直接报错。

**隐私：** 原始文件和 SQLite 索引仍在本机；显式启用远程筛选会将完整问题和候选历史原文片段发送给配置的服务。

## 0.7.23 更新

- 全部 Agent 工具结果和进度追加两行配置快照：Jev/模型、Obsidian、本地 Ollama 管理、召回数量，以及相关环境变量的 `set`/`unset`；召回折叠结果也完整显示。
- 不输出密钥值、路径或 endpoint；不改原始证据、结构化详情、检索逻辑或 Obsidian 导出。配置启用状态不等于运行时就绪状态。
- 新增隔离摘要/装饰器测试及进度、折叠显示、保密、导出 E2E 回归。本地执行 `/reload` 加载更新。

## 0.7.22 更新

- 捕获 Ollama 启动的异步进程错误；缺少 CLI 时正常拒绝并通过既有运行时诊断报告，不再因未处理的 `error` 事件导致 Pi 退出。
- Pi 回复沿 `parentId` 归属；导入和实时写入使用相同的完整历史用户编号。
- 实时写入更新追加回复及工具名；导入保留无回复用户轮次和纯工具调用信息。下次会话启动按解析器版本自动修复旧索引。
- Jev 对每个完整序列化单片段请求检查既有字节预算，包括切批后的首项；超限在发送任何批次前明确报错，不增加新的 fallback 或后端切换。
- 新增五项修复的隔离回归测试。本地执行 `/reload` 加载更新。

## 0.7.21 更新

- 召回的紧凑结果、展开原文、进度与错误逐行使用 Pi 主题的 `toolOutput` 前景色，不再继承终端默认文字颜色；不改工具面板背景或全局主题设置。
- npm 发布包包含链接到的中文 README。
- 仅修复显示，检索、Jev 筛选、去重、结构化结果与导出保持不变。本地安装执行 `/reload` 加载更新。

## 0.7.20 更新

- 共用 System One 客户端，连接参数可配置；Ollama 管理与决策请求分离。
- 兼容原有配置，远程连接要求显式模型、密钥环境变量和输入预算。
- 不改检索、分段、批处理、最大概率聚合或 `0.5` 阈值；不增加后端自动回退。

## 0.7.19 更新

- 将全局和项目召回合并为一次自动串行工具调用，保留终端阶段区分。
- 仅对项目最终结果按全局已返回轮次 ID 去重，不改检索和 Jev，不补查。
- 手动搜索菜单和 Jev 被筛除结果审查保持原行为。

## Development（开发）

```bash
npm run test:all
```
