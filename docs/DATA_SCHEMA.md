# 数据文件格式说明

本文档描述各数据文件的字段含义，面向**下游消费者**（数字人训练管线、RAG 系统、声音克隆工具等）。

所有路径相对 `data/channels/<channel-slug>/`。

---

## `channel.json`

频道元信息，每个频道一份。

```json
{
  "slug": "yutinghaofinance",
  "name": "游庭皓的財經皓角",
  "url": "https://www.youtube.com/@yutinghaofinance/streams",
  "firstSeenAt": "2026-04-19T03:15:55.123Z"
}
```

---

## `videos.jsonl`

频道 `/streams` 枚举的**全量清单**（每行一条 JSON）。这是"有哪些直播"的索引，**不代表全部都已抓取成功**（是否抓到看 `manifest.json`）。

```jsonc
{
  "id": "sRm0n7EBfyI",               // YouTube 视频 ID
  "title": "...",                    // 从 flat-playlist 拿的标题（可能是 YouTube 翻译版；processed/ 里会被 info.json 的原始标题覆盖）
  "url": "https://www.youtube.com/watch?v=sRm0n7EBfyI",
  "uploadDate": "2026-04-17",        // YYYY-MM-DD；flat-playlist 偶尔缺失，processed/ 里会补
  "duration": 1922                   // 秒；flat-playlist 偶尔缺失
}
```

---

## `manifest.json`

**增量状态机**。`fetch` 的真相来源：哪些已完成，哪些失败/跳过。

```jsonc
{
  "channelUrl": "...",
  "channelSlug": "yutinghaofinance",
  "lastRun": "2026-04-19T03:20:00.123Z",
  "videos": {
    "<videoId>": {
      "title": "...",
      "url": "...",
      "uploadDate": "2026-04-17",
      "duration": 1922,
      "processedPath": "processed/transcripts/<videoId>.json",
      "markdownPath": "corpus/markdown/2026/2026-04/...md",
      "subtitleLang": "zh-TW",              // 实际采用的字幕语言
      "subtitleSource": "manual",           // "manual" | "auto"
      "downloadedAt": "2026-04-19T03:15:57.454Z",
      "pipelineVersion": "1.0.0"            // 决定这条是否需要 rebuild
    }
  },
  "skipped": {
    "<videoId>": {
      "reason": "no-subtitles",             // "no-subtitles" | "fetch-failed" | "parse-failed"
      "lastTriedAt": "...",
      "message": "..."                      // 可选，失败细节
    }
  }
}
```

**手动干预**：删除 `skipped[id]` 后 `bun run fetch` 会重试该视频；删除 `videos[id]` 后会重抓并覆盖。

---

## `raw/subtitles/<videoId>.<lang>.vtt`

**原始 WebVTT 字幕**。这是真相源，下游所有产物都可由这个 + `info.json` 重算（靠 `bun run rebuild`）。不要修改。

每条 cue 形如：

```
00:00:22.733 --> 00:00:23.233
投資朋友
```

自动字幕还会带内联时间戳 `<00:00:22.839>` 和 `<c>...</c>` 着色标记，解析器会剥掉。

---

## `raw/video-info/<videoId>.info.json`

`yt-dlp --write-info-json` 的完整元数据（几百个字段）。本项目用到的：

- `title` — 原始标题（canonical，非翻译）
- `upload_date` / `release_date` — `YYYYMMDD`
- `duration` — 秒
- `subtitles` — 可用的**人工**字幕语言字典 `{ "zh-TW": [...], ... }`
- `automatic_captions` — 可用的**自动**字幕语言字典

---

## `processed/transcripts/<videoId>.json`

**带时间戳的结构化文字稿** — 数字人训练的核心中间产物。

```jsonc
{
  "id": "sRm0n7EBfyI",
  "title": "2026/4/17(五)高預期魔咒?台積電為何 利多不漲?...",
  "url": "https://www.youtube.com/watch?v=sRm0n7EBfyI",
  "uploadDate": "2026-04-17",
  "duration": 1922,
  "subtitleLang": "zh-TW",
  "subtitleSource": "manual",
  "segments": [
    { "start": 22.733, "end": 23.233, "text": "投資朋友" },
    { "start": 23.233, "end": 24.9,   "text": "歡迎收聽早晨財經速解讀" }
  ],
  "processedAt": "2026-04-19T03:15:57.454Z",
  "pipelineVersion": "1.0.0"
}
```

**`segments[].start/end`** 是秒（浮点），对齐原视频音轨。`pipelineVersion` 升级意味着 normalize 规则变了，旧文件需要 rebuild。

> ⚡ **这是声音克隆对齐的关键**：未来下载 `.m4a` 后，用 segments 的时间窗口切音频片段 + 对齐文本，直接得到 (audio_clip, text) 训练对。

---

## `corpus/markdown/YYYY/YYYY-MM/YYYY-MM-DD_<title>.md`

**人类可读的文字稿**。YAML frontmatter + 清理过的段落正文。面向用户浏览，不建议作为 ML 输入（机器用 JSONL）。

```markdown
---
id: sRm0n7EBfyI
title: "..."
url: https://www.youtube.com/watch?v=sRm0n7EBfyI
uploadDate: 2026-04-17
duration: 1922
subtitleLang: zh-TW
subtitleSource: manual
pipelineVersion: 1.0.0
---

# <直播标题>

**直播日期**：2026-04-17 · **时长**：32 分钟 · [YouTube 原链接](...)

---

<按语音停顿切分的段落正文...>
```

段落切分规则（`src/pipeline/normalize.ts`）：
- 连续 segments 间的停顿 > 1.5 秒 → 切新段
- 单段累计超过 280 字符 → 强制在下一个停顿切

---

## `corpus/jsonl/videos.jsonl`

**每行 = 一整场直播的拼接全文 + 元数据**。面向 LLM 风格微调、全文检索。

```jsonc
{
  "id": "sRm0n7EBfyI",
  "title": "...",
  "url": "...",
  "uploadDate": "2026-04-17",
  "duration": 1922,
  "subtitleLang": "zh-TW",
  "subtitleSource": "manual",
  "segmentCount": 1024,
  "charCount": 11186,
  "text": "投資朋友 歡迎收聽早晨財經速解讀 現在是臺北時間..."    // 所有 segments 空格拼接
}
```

---

## `corpus/jsonl/segments.jsonl`

**每行 = 一个带时间戳的段**。面向 RAG 分块、嵌入索引、音视频对齐。

```jsonc
{
  "videoId": "sRm0n7EBfyI",
  "uploadDate": "2026-04-17",
  "index": 0,                    // 该视频内的 segment 序号，从 0 开始
  "start": 22.733,
  "end": 23.233,
  "text": "投資朋友"
}
```

---

## 下游消费典型用法

**LLM 微调（风格学习）**：读 `corpus/jsonl/videos.jsonl`，每条 `text` 作为一个训练样本。

**RAG 知识库**：读 `corpus/jsonl/segments.jsonl`，按 5–10 个相邻 index 合并成 chunk，对每个 chunk 计算 embedding。查询时根据 videoId + index 可还原原文上下文。

**声音克隆 / 虚拟主播**：
1. 先用 `yt-dlp -f bestaudio -x --audio-format m4a` 下载音频到 `raw/audio/`
2. 对每个 segment，用 `start/end` 切片音频，与 `text` 配对
3. 得到 `{ audio_clip: .wav, text: "..." }` 训练对

**时序研究**（财经分析）：读 `manifest.json` 的 `uploadDate` + 某个 segment 的 `text`，就能追踪博主对某事件在不同时间点的看法。

---

## `clone/corpus.sqlite`

**数字分身的检索索引**（第四个派生层）。由 `bun run clone:build-index` 从 `corpus/jsonl/` 生成；删掉可重建，gitignore。

三张表 + 一张 FTS5 虚拟表：

```sql
-- 视频元数据（含全文，供 get_video 工具直接返回）
CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  title TEXT, url TEXT, uploadDate TEXT,
  duration INTEGER, segmentCount INTEGER, charCount INTEGER,
  fullText TEXT
);

-- 真实 segments 表，支持 (videoId, idx) O(logN) 的上下文窗口查询
CREATE TABLE segments (
  id INTEGER PRIMARY KEY,
  videoId TEXT, idx INTEGER,
  startSec REAL, endSec REAL,
  uploadDate TEXT, text TEXT,
  UNIQUE (videoId, idx)
);

-- contentless FTS5 索引，rowid = segments.id
CREATE VIRTUAL TABLE segments_fts USING fts5(
  searchText, content='', tokenize='unicode61'
);

-- 版本戳，pipeline_version 不匹配会触发 drop 重建
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
```

**CJK 分词技巧**：`unicode61` 默认不切中文，因此 `searchText` 存的是把每个 CJK code point 前后补空格的「字流」（`retrieval.ts#tokenizeForIndex`）；查询端走同一变换 + 每 token 包成 FTS5 phrase AND（`buildFtsQuery`）。不要改用 `trigram`——对 2 字查询（如「油價」）召回为空。

**一次重建的规模**（参考）：535 videos / 571,049 segments ≈ 450MB SQLite（含 WAL）。
