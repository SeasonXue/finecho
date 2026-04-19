import type { TranscriptSegment } from "../types.ts";

/**
 * 去除 YouTube 自动字幕的"滚动预览"重复：每一行常被以前缀/叠词形式多次输出。
 * 策略：若当前 cue 文本是上一 cue 文本的前缀/子串，丢弃较短的一方、保留较长的文本与更晚的 end。
 * 反过来如果下一条比当前更长且当前是它的前缀，则用下一条替换当前。
 *
 * 对于人工字幕（source="manual"），通常无滚动问题，这个算法也是幂等的（不会误删）。
 */
export function dedupeRollingSegments(input: TranscriptSegment[]): TranscriptSegment[] {
  if (input.length === 0) return [];
  const out: TranscriptSegment[] = [];
  for (const seg of input) {
    const text = seg.text.replace(/\s+/g, "").trim();
    if (!text) continue;
    const normalized: TranscriptSegment = { ...seg };

    const last = out[out.length - 1];
    if (last) {
      const lastText = last.text.replace(/\s+/g, "");
      const curText = normalized.text.replace(/\s+/g, "");
      if (curText.startsWith(lastText)) {
        // current supersedes last: replace
        out[out.length - 1] = {
          start: last.start,
          end: normalized.end,
          text: normalized.text,
        };
        continue;
      }
      if (lastText.startsWith(curText)) {
        // last already contains current: extend end, drop current
        out[out.length - 1] = { ...last, end: Math.max(last.end, normalized.end) };
        continue;
      }
    }
    out.push(normalized);
  }
  return out;
}

/** 按中文标点断句，得到完整句子数组。 */
export function splitSentences(text: string): string[] {
  const s = text.replace(/\s+/g, " ").trim();
  if (!s) return [];
  const sentences: string[] = [];
  const chars = [...s];
  let buf = "";
  for (const c of chars) {
    buf += c;
    if (c === "。" || c === "！" || c === "？" || c === "…") {
      sentences.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) sentences.push(buf.trim());
  return sentences;
}

export interface BodyOptions {
  /** 语音停顿超过此秒数则切新段 */
  gapSeconds?: number;
  /** 单段字符上限；超过就强制按语音停顿点切开 */
  maxParagraphChars?: number;
}

/**
 * 把带时间戳的 segments 拼成人读 Markdown 正文。
 * 策略：按语音停顿切段（对台湾字幕等无句末标点的情况鲁棒），
 * 同时对单段字符数设上限避免出现长墙文。
 */
export function segmentsToReadableBody(
  segments: TranscriptSegment[],
  opts: BodyOptions = {},
): string {
  const gapSeconds = opts.gapSeconds ?? 1.5;
  const maxChars = opts.maxParagraphChars ?? 280;
  if (segments.length === 0) return "";

  const paragraphs: string[] = [];
  let current: TranscriptSegment[] = [];
  let currentLen = 0;

  const flush = () => {
    if (current.length === 0) return;
    const para = current
      .map((s) => s.text.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (para) paragraphs.push(para);
    current = [];
    currentLen = 0;
  };

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const prev = segments[i - 1];
    const gap = prev ? seg.start - prev.end : 0;
    const wouldOverflow = currentLen + seg.text.length > maxChars;
    if (prev && (gap > gapSeconds || wouldOverflow)) {
      flush();
    }
    current.push(seg);
    currentLen += seg.text.length;
  }
  flush();

  return paragraphs.join("\n\n");
}
