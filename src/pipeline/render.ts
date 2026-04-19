import { appendFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProcessedTranscript } from "../types.ts";
import { safeFileName, yearMonthSegments } from "../lib/paths.ts";
import { segmentsToReadableBody } from "./normalize.ts";

export function markdownRelativePath(t: ProcessedTranscript): string {
  const { year, yearMonth } = yearMonthSegments(t.uploadDate);
  const safeTitle = safeFileName(t.title);
  return join(year, yearMonth, `${t.uploadDate}_${safeTitle}.md`);
}

function escapeYaml(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function renderMarkdown(t: ProcessedTranscript): string {
  const body = segmentsToReadableBody(t.segments);
  const durationMin = t.duration ? Math.round(t.duration / 60) : null;

  const frontmatter = [
    "---",
    `id: ${t.id}`,
    `title: "${escapeYaml(t.title)}"`,
    `url: ${t.url}`,
    `uploadDate: ${t.uploadDate}`,
    t.duration != null ? `duration: ${t.duration}` : null,
    `subtitleLang: ${t.subtitleLang}`,
    `subtitleSource: ${t.subtitleSource}`,
    `pipelineVersion: ${t.pipelineVersion}`,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  const header = [
    `# ${t.title}`,
    "",
    `**直播日期**：${t.uploadDate}${
      durationMin != null ? ` · **时长**：${durationMin} 分钟` : ""
    } · [YouTube 原链接](${t.url})`,
    "",
    "---",
    "",
  ].join("\n");

  return `${frontmatter}\n\n${header}${body}\n`;
}

export async function writeMarkdown(
  corpusMarkdownDir: string,
  t: ProcessedTranscript,
): Promise<string> {
  const rel = markdownRelativePath(t);
  const full = join(corpusMarkdownDir, rel);
  await mkdir(dirname(full), { recursive: true });
  await Bun.write(full, renderMarkdown(t));
  return rel;
}

export async function writeProcessed(
  processedDir: string,
  t: ProcessedTranscript,
): Promise<string> {
  await mkdir(processedDir, { recursive: true });
  const rel = join("transcripts", `${t.id}.json`);
  const full = join(processedDir, `${t.id}.json`);
  await Bun.write(full, JSON.stringify(t, null, 2) + "\n");
  return rel;
}

// --- JSONL aggregates (videos.jsonl + segments.jsonl) ---
// These are rebuilt from scratch to keep them in sync with processed/.

export async function resetCorpusJsonl(corpusJsonlDir: string): Promise<void> {
  await mkdir(corpusJsonlDir, { recursive: true });
  for (const name of ["videos.jsonl", "segments.jsonl"]) {
    const p = join(corpusJsonlDir, name);
    if (existsSync(p)) await rm(p);
  }
}

export async function appendToCorpusJsonl(
  corpusJsonlDir: string,
  t: ProcessedTranscript,
): Promise<void> {
  await mkdir(corpusJsonlDir, { recursive: true });
  const fullText = t.segments.map((s) => s.text).join(" ");
  const videoRow = {
    id: t.id,
    title: t.title,
    url: t.url,
    uploadDate: t.uploadDate,
    duration: t.duration ?? null,
    subtitleLang: t.subtitleLang,
    subtitleSource: t.subtitleSource,
    segmentCount: t.segments.length,
    charCount: fullText.length,
    text: fullText,
  };
  await appendFile(join(corpusJsonlDir, "videos.jsonl"), JSON.stringify(videoRow) + "\n");

  const segLines = t.segments
    .map((seg, index) =>
      JSON.stringify({
        videoId: t.id,
        uploadDate: t.uploadDate,
        index,
        start: seg.start,
        end: seg.end,
        text: seg.text,
      }),
    )
    .join("\n");
  if (segLines) {
    await appendFile(join(corpusJsonlDir, "segments.jsonl"), segLines + "\n");
  }
}
