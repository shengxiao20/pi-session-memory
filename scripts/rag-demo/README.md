# BGE-M3 独立检索实验

**读取现有 SQLite 轮次，建立独立向量快照，再输入完整 user query 检索。**

此实验位于 `scripts/rag-demo/`，独立于插件召回、Jev、咨询和 OKF。原始数据库以只读模式打开。
以下命令均从仓库根目录运行。实验源码、依赖、说明和测试不进入 npm 包。

## 目录与发布边界

```text
scripts/rag-demo/
├── __main__.py       # python3 scripts/rag-demo 的入口
├── bge_m3/           # 模型客户端、分块、存储、查询和 CLI
├── requirements.txt # 独立 Python 依赖
├── README.md        # 本说明
├── tests/           # 实验与发布边界测试
└── .npmignore       # 排除整个演示目录的内容
```

项目 `package.json` 的发布白名单不包含 `scripts/`。目录级 `.npmignore` 另行排除演示内容。
此次迁移只改变源码位置和命令入口，默认向量数据库路径保持不变；已有快照无需重建。
旧入口 `python3 -m experiments.bge_m3` 已移除，不提供兼容层。

## 准备模型服务

```bash
# 在一个终端保持本地服务运行。
ollama serve

# 在另一个终端下载模型。
ollama pull bge-m3

# 在仓库根目录安装实验依赖。
python3 -m pip install -r scripts/rag-demo/requirements.txt
```

脚本连接已有本地服务，禁用环境 HTTP 代理和服务重定向。服务和模型不可用时直接报错。

## 建立向量快照

```bash
python3 scripts/rag-demo index
```

默认读取 `MEMORY_DB_PATH`，未设置时读取 `~/.pi/agent/memory.db`。
默认写入 `~/.pi/agent/experiments/bge-m3.sqlite`。

也可以显式指定路径和参数：

```bash
python3 scripts/rag-demo index \
  --source-db "$HOME/.pi/agent/memory.db" \
  --index-db "$HOME/.pi/agent/experiments/bge-m3.sqlite" \
  --batch-size 8 --chunk-bytes 4096 --overlap-bytes 512
```

- 快照包含源 `turns` 的全部轮次，保留原始文本、轮次 ID、会话 ID、时间和目录。
- 文本格式为 `User: ...\n\nAssistant: ...`。
- 长轮次沿 Unicode 字符边界分块，每片段至多 4096 UTF-8 字节，相邻片段重叠至多 512 字节。
- 分块覆盖完整文本，偏移使用 Python Unicode 码点索引。
- 服务请求设置 `truncate=false`、`num_ctx=8192`、`num_batch=8192`。
- 所有向量必须为 1024 维有限数值，保存前执行 L2 归一化。

`num_batch` 表示服务物理 token 批容量；CLI `--batch-size` 表示一次请求的片段数量。
BGE-M3 的非因果编码需要完整片段装入物理批，故物理批容量与上下文窗口均设为 8192。

完整构建成功后，脚本原子发布实验数据库。失败时抛错，保留带 `.building-` 的诊断库，已有发布库保持。
再次构建需要显式提供 `--replace`。macOS 长任务可以使用 `caffeinate -i python3 scripts/rag-demo index` 保持系统活动。

## 输入查询

```bash
python3 scripts/rag-demo query \
  "历史会话如何顺序进行私有咨询，并保留原始 JSONL 文件？" \
  --top-k 10
```

查询全文直接送入 BGE-M3。搜索范围为整个实验快照。
每个轮次使用其片段的最大余弦相似度，返回前 K 个不同轮次。
相同相似度按时间降序和 `turn_id` 升序排列。

默认显示匹配片段前 500 个字符作为预览。完整结果用 JSON 输出：

```bash
python3 scripts/rag-demo query "你的完整 user query" \
  --top-k 20 --json > /tmp/bge-m3-results.json
```

JSON 包含：`similarity`、`turn_id`、`session_id`、`turn_index`、`cwd`、`ts`、完整 `user_text`、完整 `reply_text`、匹配片段及模型来源。
查询只读实验库。模型 digest 或向量形状不一致时直接报错。

## 查看状态与比较

```bash
python3 scripts/rag-demo info
```

`info` 只读取实验库，显示轮次数量、片段数量、模型 digest、分块参数和源快照指纹。
比较时使用同一个完整问题和相同输出数量，检查两种方案返回的 `turn_id` 和原始证据。
现有方案继续按原规则提供 `entities` 和 `primary_entity`；此实验只接收完整 query。
记录现有结果是否经过 Jev，此实验为纯向量检索。
向量结果的 `similarity` 与原字面分数、Jev Noul 分别解释。

这是快照实验。新增或修改的历史需显式重新构建。
本版每次完整构建，失败诊断库用于检查，续跑需另行实现。

## 验证与依据

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -W error -m unittest discover \
  -s scripts/rag-demo/tests -p 'test_*.py'
```

测试覆盖只读源库、完整分块、模型请求、原文返回、最大片段排名、版本校验和失败发布行为。
还检查目录入口、实际 npm 包清单，以及 `scripts/` 被整体纳入发布时的目录级排除规则。
测试只使用临时数据，不启动模型服务，也不写入现有历史或向量库。

- [现有 SQLite 字段](../../src/history/db.ts#L9)
- [实验实现](bge_m3/)
- [Ollama embedding API](https://docs.ollama.com/api/embed)
- [BGE-M3 dense embedding 说明](https://bge-model.com/bge/bge_m3.html)

实验数据库包含原始历史文本，请按源数据库的敏感级别管理。
