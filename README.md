# finance-transcripts

批量下载 YouTube 财经博主的直播文字稿，组织为**面向数字人语料**的结构化数据集。

## 目标频道

- [游庭皓的財經皓角](https://www.youtube.com/@yutinghaofinance/streams)

---

## 零基础上手

### 1. 装两个命令行工具（macOS）

```bash
# 如果还没装 Homebrew，先装：
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 装 bun（JavaScript 运行时，相当于 node 的加强版）
brew tap oven-sh/bun
brew install bun

# 装 yt-dlp（YouTube 下载器，本项目真正干活的工具）
brew install yt-dlp
```

验证：

```bash
bun --version     # 应该显示 1.3.x
yt-dlp --version  # 应该显示 2025.xx.xx 或更新
```

### 2. 装项目依赖

```bash
bun install
```

只会装 TypeScript 和 Bun 类型文件，秒级完成。

### 3. 试跑 3 场直播

```bash
bun run fetch --limit 3
```

成功后你会看到：
```
[yutinghaofinance] listing live streams …
✓ found 993 live streams
3 to process (already done: 0, skipped: 0)
[1/3] sRm0n7EBfyI manual zh-TW ← 2026-04-17
[2/3] iUY1Ql7xFFI manual zh-TW ← 2026-04-16
[3/3] x6IUl6C0wrM manual zh-TW ← 2026-04-15
✓ fetch done: 3 processed, 0 skipped
```

打开 `data/channels/yutinghaofinance/corpus/markdown/2026/2026-04/` 随便看一个 `.md` 文件 — 这就是清理好的文字稿。

### 4. 全量抓取

```bash
bun run fetch     # 会从上次进度继续，已抓过的自动跳过
```

993 场历史直播预计 30–60 分钟（取决于网速和 YouTube 响应）。中途 Ctrl+C 不怕丢，再跑一次继续即可。

---

## 命令速查

| 命令                            | 作用                                                                      |
| ------------------------------- | ------------------------------------------------------------------------- |
| `bun run fetch`                 | 增量下载：枚举频道 → 跳过已有 → 抓字幕 → 解析 → 生成产物                  |
| `bun run fetch --limit 3`       | 只抓 3 条（调试/试水）                                                     |
| `bun run fetch --concurrency 5` | 并发数（默认 3；调高可能触发 YouTube 限流 429）                             |
| `bun run fetch --force`         | 忽略已下载状态，**全部重抓**（会重置 corpus/jsonl 避免重复行）               |
| `bun run rebuild`               | 不请求 YouTube，仅从本地 `raw/` 重算 `processed/` 和 `corpus/`              |
| `bun run stats`                 | 打印语料统计（视频数、总时长、总字数、月度分布）                            |
| `bun run typecheck`             | TypeScript 类型检查                                                        |

---

## 数据分层

三层结构，blast radius 严格递增：**raw 只写不删，processed 和 corpus 随时可重建**。

```
data/channels/yutinghaofinance/
├── channel.json                  ← 频道元信息
├── videos.jsonl                  ← 频道枚举到的全部视频清单（每行一条）
├── manifest.json                 ← 增量状态（哪些已下载 / 跳过 / 失败）
├── raw/
│   ├── subtitles/                ← 原始 WebVTT 字幕（<videoId>.<lang>.vtt）
│   │   └── sRm0n7EBfyI.zh-TW.vtt
│   ├── video-info/               ← yt-dlp --write-info-json 的完整元数据
│   │   └── sRm0n7EBfyI.info.json
│   └── audio/                    ← 占位：未来声音克隆的 .m4a 放这里
├── processed/
│   └── transcripts/              ← 解析后的结构化段（带秒级时间戳）
│       └── sRm0n7EBfyI.json
└── corpus/
    ├── markdown/                 ← 人类浏览，按年/月分层
    │   └── 2026/2026-04/2026-04-17_<标题>.md
    └── jsonl/                    ← 机器可读，面向 LLM 管线
        ├── videos.jsonl          ← 每行一整场直播（全文 + 元数据）
        └── segments.jsonl        ← 每行一个带时间戳的段（面向 RAG 分块和音频对齐）
```

### 三层的职责

| 层           | 规则                   | 什么时候动它                                                          |
| ------------ | ---------------------- | --------------------------------------------------------------------- |
| `raw/`       | **永远只写不改**        | 只有 `fetch` 会写。删除 = 必须重新请求 YouTube 才能恢复                 |
| `processed/` | 由 `rebuild` 从 raw 重建 | 改了 `src/pipeline/parse-vtt.ts` 或 `normalize.ts` 后要 rebuild         |
| `corpus/`    | 由 `rebuild` 从 processed 重建 | 改了 `src/pipeline/render.ts`（markdown 模板、jsonl 字段）后要 rebuild |

### 典型工作流

**改段落切分规则后刷新所有文件**（不烧 YouTube 额度）：

```bash
vim src/pipeline/normalize.ts   # 改 gapSeconds 或 maxParagraphChars
bun run rebuild                  # 从 raw 重跑 processed + corpus
```

**发现几场直播解析失败想重试**：

```bash
# 打开 manifest.json，手动删除 "skipped" 里那几个 id
bun run fetch   # 下次 fetch 会重新尝试那些 id
```

---

## 故障排查

| 症状                                                | 可能原因                               | 解决                                               |
| --------------------------------------------------- | -------------------------------------- | -------------------------------------------------- |
| `yt-dlp: command not found`                         | 没装 yt-dlp                            | `brew install yt-dlp`                              |
| `bun install` 静默无输出、`node_modules` 不存在     | pnpm 装的坏 bun 顶替了 brew 版本       | `/opt/homebrew/bin/bun install` 绝对路径           |
| 某些视频 `skip (no subs)`                           | 博主没上传字幕，YouTube 也没自动生成   | 无解，跳过即可                                     |
| 大量 `fetch-failed` 错误                            | YouTube 限流（429）或网络                | 降低 `--concurrency`；等十几分钟再跑               |
| Markdown 标题显示英文（如 "April 14, 2026..."）      | YouTube 给返回了自动翻译版标题          | 已在 `src/cli/fetch.ts` 用 `info.json` 里的原始标题兜底 |
| 段落粘成一大坨无换行                                | 字幕无 `。？！` 标点                    | 已按语音停顿 `gapSeconds > 1.5s` 自动切段          |

---

## 未来扩展

### 加入新的博主

在 `src/channels.ts` 里追加一条：

```ts
export const CHANNELS: ChannelConfig[] = [
  { slug: "yutinghaofinance", name: "游庭皓的財經皓角", url: "https://www.youtube.com/@yutinghaofinance/streams" },
  { slug: "another-blogger", name: "XXX", url: "https://www.youtube.com/@another/streams" },
];
```

然后 `bun run fetch --channel another-blogger`。

### 下载音频（声音克隆准备）

`raw/audio/` 目录已预留。未来加一个 `bun run fetch-audio` 子命令调 `yt-dlp -f bestaudio -x --audio-format m4a` 即可，目录结构不需要动。

### 导出训练集

`corpus/jsonl/videos.jsonl` 直接喂 LLM 风格微调；`corpus/jsonl/segments.jsonl` 直接喂 RAG 分块或声音克隆的音视频对齐。

---

## 相关文档

- [docs/DATA_SCHEMA.md](docs/DATA_SCHEMA.md) — 所有产出文件的字段释义，下游消费者（数字人训练、RAG、声音克隆）必读

---

## 项目结构速览

```
src/
├── index.ts               ← CLI 入口
├── channels.ts            ← 频道配置
├── types.ts               ← 共享类型 + pipelineVersion
├── cli/
│   ├── fetch.ts           ← 增量抓取主流程
│   ├── rebuild.ts         ← 仅从 raw 重建 processed+corpus
│   └── stats.ts           ← 统计报告
├── pipeline/
│   ├── list-videos.ts     ← 阶段0：枚举 /streams
│   ├── fetch-subtitles.ts ← 阶段1：下载 VTT + info.json
│   ├── parse-vtt.ts       ← 阶段2：VTT → 带时间戳段
│   ├── normalize.ts       ← 阶段3：滚动字幕去重、段落切分
│   └── render.ts          ← 阶段4：写 markdown + jsonl
└── lib/
    ├── yt-dlp.ts          ← Bun.spawn 封装 + 流式 JSON 行解析
    ├── manifest.ts        ← 增量状态读写
    ├── paths.ts           ← 所有路径常量 + 中文安全文件名
    ├── concurrency.ts     ← 简易 pLimit
    └── logger.ts          ← stderr 单行进度
```
