import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "..", "..");
export const DATA_ROOT = join(REPO_ROOT, "data");
export const CHANNELS_ROOT = join(DATA_ROOT, "channels");

export function channelDir(slug: string): string {
  return join(CHANNELS_ROOT, slug);
}

export function channelPaths(slug: string) {
  const base = channelDir(slug);
  return {
    base,
    channelJson: join(base, "channel.json"),
    videosJsonl: join(base, "videos.jsonl"),
    manifestJson: join(base, "manifest.json"),
    rawSubtitles: join(base, "raw", "subtitles"),
    rawAudio: join(base, "raw", "audio"),
    rawVideoInfo: join(base, "raw", "video-info"),
    processedTranscripts: join(base, "processed", "transcripts"),
    corpusMarkdown: join(base, "corpus", "markdown"),
    corpusJsonl: join(base, "corpus", "jsonl"),
  };
}

/**
 * 中文安全的文件名清洗：
 * - 替换 Windows/POSIX 保留字符
 * - 合并空白，trim
 * - 限长 80 字符（按 code point，避免切半个字符）
 */
export function safeFileName(raw: string, maxLen = 80): string {
  const replaced = raw
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...replaced];
  if (chars.length <= maxLen) return replaced;
  return chars.slice(0, maxLen).join("");
}

/** YYYYMMDD → YYYY-MM-DD */
export function formatUploadDate(yyyymmdd: string): string {
  if (/^\d{8}$/.test(yyyymmdd)) {
    return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  }
  return yyyymmdd;
}

/** 返回 YYYY / YYYY-MM 相对分段 */
export function yearMonthSegments(uploadDate: string): { year: string; yearMonth: string } {
  const year = uploadDate.slice(0, 4);
  const yearMonth = uploadDate.slice(0, 7);
  return { year, yearMonth };
}
