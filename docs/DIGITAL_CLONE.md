# 数字分身使用手册

基于 Claude Agent SDK + 本地 SQLite FTS5 检索，把游庭皓历史直播语料接入 Claude Sonnet，以他的口吻回答财经问题并附 YouTube 时间戳引用。

---

## 1. 快速开始

### 1.1 凭证

两种方式二选一，写进仓库根目录 `.env`（模板见 `.env.example`）：

| 方式 | 环境变量 | 怎么拿 | 适用场景 |
|---|---|---|---|
| **订阅账号**（推荐） | `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` 交互式登录后打印 `sk-ant-oat01-...` | Pro/Max 订阅者，走订阅配额不再按 token 计费 |
| **API Key** | `ANTHROPIC_API_KEY` | <https://console.anthropic.com/> | 脚本化批量任务、无订阅限流 |

```bash
cp .env.example .env
# 编辑 .env，填其一
```

Bun 启动时自动加载 `.env`，**无需 dotenv 依赖**。

### 1.2 构建索引（一次性）

前置：`corpus/jsonl/` 已经存在（`bun run fetch` 或 `bun run rebuild` 生成）。

```bash
bun run clone:build-index              # 默认频道 yutinghaofinance
bun run clone:build-index --force      # 强制删库重建
bun run clone:build-index --channel <slug>
```

产物：`data/channels/<slug>/clone/corpus.sqlite`。

**什么时候要重建**：
- 改了 `src/clone/retrieval.ts` 的 tokenize / schema → bump `PIPELINE_VERSION`（`src/types.ts`）后下次启动会自动重建
- 新抓了直播，想把新语料灌进去 → 直接再跑 `clone:build-index`（`INSERT OR IGNORE` 幂等）

### 1.3 对话

```bash
bun run clone                          # 进入 REPL
bun run clone --once "游老师最近怎么看油价？"    # 单轮，输出到 stdout
bun run clone --model claude-opus-4-5          # 覆盖默认模型
```

REPL 里会实时回显 agent 调用了哪些检索工具，例如：

```
你 > 最近怎么看台积电？
  ⋯ search_segments(query="台積電" limit=6)
  ⋯ list_videos_by_date(start="2026-04-01" end="2026-04-19")
游 > 投資朋友，從最近這幾週的直播來看...
  [2 tool calls · $0.0134 · 8421ms]
```

---

## 2. 架构

```
┌──────────────────────────────────────────────────────────┐
│  src/clone/                                              │
│  ├─ retrieval.ts       纯函数 + SQLite schema（可测）    │
│  ├─ retrieval.test.ts  表驱动测试，tmpdir 真 IO 不 mock  │
│  ├─ index-build.ts     JSONL → SQLite，流式 + 事务       │
│  ├─ persona.ts         system prompt + 风格样本          │
│  ├─ tools.ts           三个 MCP in-process tool 定义     │
│  ├─ agent.ts           SDK 封装：askOnce / chatSession   │
│  └─ repl.ts            CLI 交互循环（process.stdin 行读） │
│                                                          │
│  src/cli/clone.ts      CLI 分发入口                      │
│  data/channels/<slug>/clone/corpus.sqlite  派生层        │
└──────────────────────────────────────────────────────────┘
```

### 2.1 三个 MCP 工具

工具用 `@anthropic-ai/claude-agent-sdk` 的 `tool()` + `createSdkMcpServer()` 定义，**进程内调用**，无 IPC 开销。

| 工具 | 输入 | 返回 | 何时用 |
|---|---|---|---|
| `search_segments` | `query` + 可选 `limit` / `sinceDate` | Top-N 段 + 上下文窗口（前 1 后 3 句），命中用 `【】` 包裹 | 主力检索，所有问题都应先调 |
| `list_videos_by_date` | `start` + `end` | 区间内所有直播元信息 | 「最近 / 上週 / 今年」类问题 |
| `get_video` | `videoId` + 可选 `maxChars` | 某场直播完整转录 | 深挖某期完整语境 |

返回里每条命中都带 `sourceUrl`（`...&t=<startSec>s`），用户点击能跳回 YouTube 对应时刻。

### 2.2 人格（persona）

`src/clone/persona.ts` 的 `buildSystemPrompt()` 组装三段：

1. **核心身份** — 繁中 + 台湾用语 + 博弈论/市场结构/乖离/空单回补等专属分析框架
2. **回答流程硬约束** — 必须先调 `search_segments`、引用必走工具、不给个股建议、语料外就说「沒有涉及」
3. **风格样本** — 从语料手挑的 6 句真实直播原话，示范开场白 / 推理节奏 / 收束

更新人格：改 `STYLE_SAMPLES` 或 `PERSONA_CORE` 后 **bump `PERSONA_VERSION`**，方便后续回放调试。

### 2.3 多轮会话

`createChatSession()` 用手动驱动的 `AsyncQueue` 给 SDK 的 `query({ prompt: AsyncIterable })` 喂 `SDKUserMessage`，每轮一个 waiter Promise。背景 `for await` 循环消费 SDK 的消息流，把文本增量累计到 `turnRef.current.text`，遇到 `result` 消息 resolve promise。

**不要改** 的两个关键 option：
- `permissionMode: "bypassPermissions"` — 让工具调用自动通过（数字分身场景不需要二次确认）
- `settingSources: []` — 让 SDK 忽略用户全局 `~/.claude/` 配置，保证数字分身是独立人格、不被用户的个人 CLAUDE.md 污染

---

## 3. 扩展

### 3.1 加新频道

1. `src/channels.ts` 的 `CHANNELS` 加一条
2. `bun run fetch --channel <slug>`
3. `bun run clone:build-index --channel <slug>`
4. 为新博主起独立人格：复制 `persona.ts` 思路或做成多 persona 分发
5. `bun run clone --channel <slug>`

### 3.2 加新工具

在 `src/clone/tools.ts` 用 `tool(name, description, zodSchema, handler)` 新定义，加进 `createCorpusMcpServer` 的 `tools` 数组，并在 `ALLOWED_CORPUS_TOOLS` 把全名登记（`mcp__yutinghao-corpus__<name>`）。handler 必须返回 `{ content: [{ type: "text", text: "..." }] }`。

**测试约定**：检索逻辑放 `retrieval.ts` 抽成纯函数，tools.ts 里只做 zod 解析 + 文本格式化；前者走 `retrieval.test.ts` 表驱动覆盖（tmpdir 建小 SQLite、**不 mock**），后者不需要单测。

### 3.3 切换模型

三个优先级（从高到低）：

1. 命令行：`bun run clone --model claude-opus-4-5`
2. 环境变量：`.env` 里 `ANTHROPIC_MODEL=claude-opus-4-5`
3. 代码默认：`src/clone/agent.ts` 的 `FALLBACK_MODEL`

---

## 4. 成本 & 限流

- **Sonnet**：单轮平均 3–5k tokens context，约 **$0.01–0.03/轮**（按 API 计费）
- **订阅账号**：不按 token 计费，但有 RPM / 并发上限；脚本化跑 100 条以上建议走 API Key
- 每轮结束 REPL 会回显成本 + 耗时，方便监控

---

## 5. 常见问题

**Q: 问了一个语料里明明有的关键词，但 agent 说没找到？**
大多是 tokenize 不一致。检查 `retrieval.ts#tokenizeForIndex` 和 `buildFtsQuery` 是否走了同一套变换；`sqlite3 corpus.sqlite 'SELECT searchText FROM segments_fts LIMIT 3'` 看实际存的字流。

**Q: 回答串简体了？**
persona prompt 已硬约束繁体输出。若仍偶发，检查用户问题里是否粘了大量简中历史对话——session 上下文越长越容易偏。`close()` 重开 session 可复位。

**Q: 重建索引卡在 `UNIQUE constraint failed`？**
`INSERT OR IGNORE` 本来应该吸收重复。如果真抛了，是 schema 或 (videoId, idx) 约束变了；`--force` 删库重建。

**Q: REPL 多行输入？**
当前按 `\n` 直接提交。想要多行：先复制粘贴到外部编辑器，或未来再扩展。

---

## 6. 相关文件

- 架构：`CLAUDE.md` 的「数字分身（src/clone/）」小节
- SQLite schema：`docs/DATA_SCHEMA.md` 的 `clone/corpus.sqlite` 小节
- 实现：`src/clone/*.ts`
- 测试：`src/clone/retrieval.test.ts`（19 用例）
