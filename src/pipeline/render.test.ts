import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PIPELINE_VERSION, type ProcessedTranscript } from "../types.ts";
import {
  appendToCorpusJsonl,
  markdownRelativePath,
  renderMarkdown,
  resetCorpusJsonl,
  writeMarkdown,
  writeProcessed,
} from "./render.ts";

const tmpDirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

const baseTranscript = (overrides: Partial<ProcessedTranscript> = {}): ProcessedTranscript => ({
  id: "abc123",
  title: "今日财经速报",
  url: "https://www.youtube.com/watch?v=abc123",
  uploadDate: "2026-04-19",
  duration: 3600,
  subtitleLang: "zh-Hant",
  subtitleSource: "auto",
  segments: [
    { start: 0, end: 2, text: "开场白" },
    { start: 2.1, end: 4, text: "正文一段" },
  ],
  processedAt: "2026-04-19T08:00:00.000Z",
  pipelineVersion: PIPELINE_VERSION,
  ...overrides,
});

describe("markdownRelativePath", () => {
  it("按 year/year-month/YYYY-MM-DD_title.md 组织路径", () => {
    const t = baseTranscript();
    expect(markdownRelativePath(t)).toBe("2026/2026-04/2026-04-19_今日财经速报.md");
  });

  it("标题中的非法字符被替换", () => {
    const t = baseTranscript({ title: "a/b:c?d" });
    expect(markdownRelativePath(t)).toBe("2026/2026-04/2026-04-19_a_b_c_d.md");
  });

  it("超长中文标题按 80 code point 截断", () => {
    const t = baseTranscript({ title: "甲".repeat(100) });
    const path = markdownRelativePath(t);
    expect(path.startsWith("2026/2026-04/2026-04-19_")).toBe(true);
    const titlePart = path.slice("2026/2026-04/2026-04-19_".length, -".md".length);
    expect([...titlePart]).toHaveLength(80);
  });
});

describe("renderMarkdown", () => {
  it("frontmatter 包含必需字段，标题中的双引号被转义", () => {
    const t = baseTranscript({ title: '他说"赚钱"很难' });
    const md = renderMarkdown(t);
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain(`id: ${t.id}`);
    expect(md).toContain('title: "他说\\"赚钱\\"很难"');
    expect(md).toContain(`url: ${t.url}`);
    expect(md).toContain(`uploadDate: ${t.uploadDate}`);
    expect(md).toContain(`duration: ${t.duration}`);
    expect(md).toContain(`subtitleLang: ${t.subtitleLang}`);
    expect(md).toContain(`subtitleSource: ${t.subtitleSource}`);
    expect(md).toContain(`pipelineVersion: ${t.pipelineVersion}`);
  });

  it("duration 为空时省略 duration 字段且头部不显示时长", () => {
    const t = baseTranscript({ duration: undefined });
    const md = renderMarkdown(t);
    expect(md).not.toContain("duration:");
    expect(md).not.toContain("时长");
  });

  it("正文按 segments 渲染，非空段以两个换行分隔", () => {
    const t = baseTranscript({
      segments: [
        { start: 0, end: 2, text: "上半段" },
        { start: 100, end: 102, text: "下半段" },
      ],
    });
    const md = renderMarkdown(t);
    expect(md).toContain("# 今日财经速报");
    expect(md).toContain("上半段\n\n下半段");
  });

  it("文件以单个换行结尾", () => {
    expect(renderMarkdown(baseTranscript()).endsWith("\n")).toBe(true);
  });

  it("时长按分钟四舍五入显示", () => {
    const t = baseTranscript({ duration: 90 }); // 1.5 分钟
    expect(renderMarkdown(t)).toContain("**时长**：2 分钟");
  });

  it("反斜杠在 frontmatter 中被双重转义", () => {
    const t = baseTranscript({ title: "a\\b" });
    expect(renderMarkdown(t)).toContain('title: "a\\\\b"');
  });
});

describe("writeMarkdown", () => {
  it("按相对路径落盘并自动建目录", async () => {
    const dir = await makeTmp("write-md-");
    const t = baseTranscript();
    const rel = await writeMarkdown(dir, t);
    expect(rel).toBe("2026/2026-04/2026-04-19_今日财经速报.md");
    const full = join(dir, rel);
    expect(existsSync(full)).toBe(true);
    const content = await readFile(full, "utf8");
    expect(content).toBe(renderMarkdown(t));
  });
});

describe("writeProcessed", () => {
  it("写出 <id>.json 到 processedDir，返回 transcripts/<id>.json 相对路径", async () => {
    const dir = await makeTmp("write-proc-");
    const t = baseTranscript();
    const rel = await writeProcessed(dir, t);
    expect(rel).toBe(join("transcripts", `${t.id}.json`));
    const full = join(dir, `${t.id}.json`);
    expect(existsSync(full)).toBe(true);
    const parsed = JSON.parse(await readFile(full, "utf8"));
    expect(parsed.id).toBe(t.id);
    expect(parsed.segments).toHaveLength(t.segments.length);
  });
});

describe("resetCorpusJsonl", () => {
  it("删除已存在的 videos.jsonl 与 segments.jsonl", async () => {
    const dir = await makeTmp("reset-jsonl-");
    const v = join(dir, "videos.jsonl");
    const s = join(dir, "segments.jsonl");
    await writeFile(v, "stale\n");
    await writeFile(s, "stale\n");
    await resetCorpusJsonl(dir);
    expect(existsSync(v)).toBe(false);
    expect(existsSync(s)).toBe(false);
  });

  it("目录或文件不存在也不报错", async () => {
    const dir = await makeTmp("reset-jsonl-empty-");
    await resetCorpusJsonl(join(dir, "nested"));
    expect(existsSync(join(dir, "nested"))).toBe(true);
  });
});

describe("appendToCorpusJsonl", () => {
  it("videos.jsonl 每行是一个完整视频，含全文与统计", async () => {
    const dir = await makeTmp("append-jsonl-");
    const t = baseTranscript();
    await appendToCorpusJsonl(dir, t);
    const lines = (await readFile(join(dir, "videos.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!);
    expect(row).toMatchObject({
      id: t.id,
      title: t.title,
      url: t.url,
      uploadDate: t.uploadDate,
      duration: t.duration,
      subtitleLang: t.subtitleLang,
      subtitleSource: t.subtitleSource,
      segmentCount: t.segments.length,
    });
    expect(row.text).toBe(t.segments.map((s) => s.text).join(" "));
    expect(row.charCount).toBe(row.text.length);
  });

  it("segments.jsonl 每段一行，带 videoId / index / 时间戳", async () => {
    const dir = await makeTmp("append-jsonl-segs-");
    const t = baseTranscript();
    await appendToCorpusJsonl(dir, t);
    const lines = (await readFile(join(dir, "segments.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(t.segments.length);
    const first = JSON.parse(lines[0]!);
    expect(first).toEqual({
      videoId: t.id,
      uploadDate: t.uploadDate,
      index: 0,
      start: t.segments[0]!.start,
      end: t.segments[0]!.end,
      text: t.segments[0]!.text,
    });
    const second = JSON.parse(lines[1]!);
    expect(second.index).toBe(1);
  });

  it("duration 缺省时序列化为 null", async () => {
    const dir = await makeTmp("append-jsonl-noduration-");
    await appendToCorpusJsonl(dir, baseTranscript({ duration: undefined }));
    const row = JSON.parse(
      (await readFile(join(dir, "videos.jsonl"), "utf8")).trim(),
    );
    expect(row.duration).toBeNull();
  });

  it("零段视频不写 segments.jsonl", async () => {
    const dir = await makeTmp("append-jsonl-zero-");
    await appendToCorpusJsonl(dir, baseTranscript({ segments: [] }));
    expect(existsSync(join(dir, "videos.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "segments.jsonl"))).toBe(false);
  });

  it("追加多次时累积写入", async () => {
    const dir = await makeTmp("append-jsonl-multi-");
    await appendToCorpusJsonl(dir, baseTranscript({ id: "v1" }));
    await appendToCorpusJsonl(dir, baseTranscript({ id: "v2" }));
    const lines = (await readFile(join(dir, "videos.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).id).toBe("v1");
    expect(JSON.parse(lines[1]!).id).toBe("v2");
  });
});
