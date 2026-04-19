# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

批量抓取 YouTube 财经博主直播字幕，结构化为**面向数字人语料**的数据集。当前唯一频道是「游庭皓的財經皓角」（`yutinghaofinance`）。注意博主中文名是**游庭皓**，不要写成「于霆皓」。

## 运行环境

- **运行时**：bun（macOS 上通过 `brew install bun`，安装路径 `/opt/homebrew/bin/bun`；不要用 pnpm 装的那个，是坏的）
- **外部依赖**：`yt-dlp`（`brew install yt-dlp`），所有 YouTube 请求都走它

## 常用命令

```bash
bun install
bun run fetch --limit 3         # 抓 3 场试水
bun run fetch                   # 全量，支持 --force / --channel <slug> / --concurrency N
bun run rebuild                 # 不请求 YouTube，仅从 raw/ 重建 processed/ + corpus/
bun run stats                   # 语料统计
bun run typecheck               # tsc --noEmit
bun test                        # 跑测试（bun 内置 test runner，无需额外依赖）
bun test src/pipeline/normalize.test.ts   # 跑单个文件
bun test --watch                # 监听模式，TDD 标配

# 数字分身（需 ANTHROPIC_API_KEY）
bun run clone:build-index       # 从 corpus/jsonl 建 SQLite FTS5 索引 → data/channels/<slug>/clone/corpus.sqlite
bun run clone                   # 进入 REPL 对话
bun run clone --once "问题"     # 单轮问答，适合脚本化
```

## 开发流程：TDD

**所有逻辑改动必须走 TDD 红-绿-重构循环**，尤其是 `src/pipeline/` 和 `src/lib/` 里的纯函数（`dedupeRollingSegments`、`splitSentences`、`segmentsToReadableBody`、`safeFileName`、`formatUploadDate`、`markdownRelativePath` 等）。

1. **红**：先在 `*.test.ts`（紧挨被测文件放）写失败测试，`bun test` 确认失败。命名用 `describe(函数名)` + `it("描述输入/期望")`。
2. **绿**：写最小实现让测试通过。
3. **重构**：在测试保护下清理代码。

规则：
- 测试用 `bun:test`（`import { describe, it, expect } from "bun:test"`），不要引入 vitest / jest。
- 纯函数优先写表驱动测试；涉及 yt-dlp / 文件系统 的模块，要么抽出纯函数单独测，要么在测试里用 `tmpdir` 做真实 IO（**不要 mock** `yt-dlp` 的 stdout 字符串，失真）。
- Bug 修复：先写一个重现该 bug 的失败测试，再改代码。没有回归测试的修复不算完成。
- 提交前跑 `bun run typecheck && bun test` 两项都过。

## 架构

### 三层数据流

```
raw/              # 源真相：yt-dlp 原始产物（*.vtt + *.info.json），只追加不改
  └─ 只能由 fetch 生成；删掉就得重新请求 YouTube
processed/        # 结构化：按 videoId 一个 JSON，带时间戳 segments
  └─ 由 rebuild 从 raw/ 可无损重建
corpus/           # 训练就绪层
  ├─ markdown/    # 人读：YAML frontmatter + 按停顿分段的正文
  └─ jsonl/       # 机读：videos.jsonl（整篇）+ segments.jsonl（每段）
```

任何派生层被删都能 `bun run rebuild` 重建。**这是增量设计的核心**——修改 `normalize` / `render` 的逻辑后，bump `PIPELINE_VERSION`（`src/types.ts`），然后 rebuild 就能全量刷新派生数据而不重抓 YouTube。

### CLI 分发

`src/index.ts` 手写 arg parser → 分发到 `src/cli/{fetch,rebuild,stats}.ts`。新加命令：在 `index.ts` 的 switch 加分支 + 在 `cli/` 加文件。不要引入 commander / yargs 这类框架。

### 频道配置

`src/channels.ts` 硬编码 `CHANNELS` 数组。加新频道就在这里加一项 `{ slug, name, url }`，数据自动按 slug 分目录落盘。

### yt-dlp 封装

`src/lib/yt-dlp.ts` 提供两种调用：
- `ytDlpRun(args)`：一次性 stdout，失败抛 `YtDlpError`（带 exitCode + stderr）。
- `ytDlpJsonLines(args)`：流式逐行 JSON，配 `--dump-json` 用，列频道视频时必用（频道动辄几百场直播）。

重试策略在 `fetch-subtitles.ts` 的 `withRetry`：指数退避 3 次，但遇到 `video unavailable` / `private video` / `404` 立即放弃。新加 yt-dlp 调用要沿用这个策略。

### 滚动字幕去重（关键算法）

YouTube 自动字幕是"滚动预览"模式，同一句会被前缀/叠词形式重复输出几十次。`src/pipeline/normalize.ts#dedupeRollingSegments` 通过前缀匹配合并：若当前 cue 是前一 cue 的扩展（前缀关系），替换前一条并延长 end 时间；反之则丢弃当前。**这个算法对人工字幕幂等**，所以统一跑一遍。改这里务必补表驱动测试覆盖前缀、相等、无关三类情况。

### Manifest 增量

`data/channels/<slug>/manifest.json` 记录 `videos`（已成功）和 `skipped`（失败原因 + 最后尝试时间）。`runFetch` 默认跳过两类；`--force` 才重跑。每处理 10 条落盘一次 manifest 以便中断后续跑。

### 语言优先级

字幕挑选按 `LANG_PRIORITY = ["zh-Hans", "zh-CN", "zh-Hant", "zh-TW", "zh"]`（定义在 `src/pipeline/fetch-subtitles.ts`），先找人工字幕（`subtitles`），再找自动字幕（`automatic_captions`）。`rebuild` 时走 `src/cli/rebuild.ts#pickFromFiles`，只用磁盘上已存在的 vtt。

### Markdown 落盘路径

`src/pipeline/render.ts#markdownRelativePath`：`<year>/<year-month>/<YYYY-MM-DD>_<safe-title>.md`。`safeFileName` 按 code point 截断 80 字符，中文安全。

### 数字分身（src/clone/）

基于 Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）+ 本地 SQLite FTS5 检索，把语料接入 Claude Sonnet，让它用游庭皓的口吻回答财经问题并附带 YouTube 时间戳引用。

数据流：`corpus/jsonl/{videos,segments}.jsonl` → `data/channels/<slug>/clone/corpus.sqlite`（第四个派生层，gitignore）。schema 与算法见 `retrieval.ts`；关键点：

- **FTS5 tokenize**：用 `unicode61` + 把 CJK code point 前后补空格（`tokenizeForIndex`）。`trigram` 分词器对 2 字查询召回为空，必须用这个方案；索引与查询走同一套变换。
- **hybrid 表**：`segments` 是 real table（带 `(videoId, idx)` 唯一索引，用于上下文窗口），`segments_fts` 是 contentless 虚拟表，通过 rowid 关联。
- **重建幂等**：`INSERT OR IGNORE` 吸收 JSONL 里 `(videoId, idx)` 的重复（历史 append 产物），`pipeline_version` 不匹配会自动删库重建。

Agent 有三个 MCP in-process tool（`src/clone/tools.ts`）：`search_segments`（FTS5 关键词 + 上下文窗口高亮）、`list_videos_by_date`、`get_video`。`persona.ts` 的 system prompt 强制：繁体中文输出、引用必走工具、不给个股建议。

多轮会话（`createChatSession`）用手动驱动的 `AsyncQueue` 把用户消息喂给 SDK 的 `query({ prompt: AsyncIterable })`，每轮一个 waiter Promise；改这里注意 `permissionMode: "bypassPermissions"` + `settingSources: []` 要保留——前者让 tool 自动调用，后者让 SDK 忽略用户全局 `~/.claude/CLAUDE.md`（数字分身是独立人格，不要被全局配置污染）。

凭证：`.env` 里设 `CLAUDE_CODE_OAUTH_TOKEN`（订阅账号，`claude setup-token` 生成）或 `ANTHROPIC_API_KEY` 任一；可选 `ANTHROPIC_MODEL` 覆盖默认模型。bun 自动加载 `.env`。详见 `docs/DIGITAL_CLONE.md`。

## 代码风格约定

- 所有内部 import 带 `.ts` 后缀（`verbatimModuleSyntax` + `allowImportingTsExtensions` 开着）。
- 严格模式 + `noUncheckedIndexedAccess`：数组下标访问返回 `T | undefined`，写代码时必须处理。
- 错误消息、日志、注释用中文是常态（贴合项目语境），英文也可。
- 所有文件 IO 走 `Bun.write` / `Bun.file` / `node:fs/promises`，不要混 `fs.writeFileSync`。
