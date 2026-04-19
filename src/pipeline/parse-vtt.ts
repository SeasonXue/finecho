import type { TranscriptSegment } from "../types.ts";

const CUE_TIME_RE =
  /^((?:\d{1,2}:)?\d{1,2}:\d{2}\.\d{3})\s+-->\s+((?:\d{1,2}:)?\d{1,2}:\d{2}\.\d{3})/;

/** "01:23:45.678" | "23:45.678" → seconds */
function parseTime(s: string): number {
  const parts = s.split(":");
  const sec = parts.length === 3
    ? Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2])
    : parts.length === 2
    ? Number(parts[0]) * 60 + Number(parts[1])
    : NaN;
  return Number.isFinite(sec) ? sec : NaN;
}

function cleanCueText(raw: string): string {
  return raw
    .replace(/<\d{1,2}:\d{2}:\d{2}\.\d{3}>/g, "")
    .replace(/<\/?c(\.[A-Za-z0-9_-]+)*>/g, "")
    .replace(/<\/?v(\.[A-Za-z0-9_-]+)*(?:\s+[^>]*)?>/g, "")
    .replace(/<\/?[bi]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function parseVtt(vttPath: string): Promise<TranscriptSegment[]> {
  const text = await Bun.file(vttPath).text();
  const lines = text.split(/\r?\n/);
  const segments: TranscriptSegment[] = [];

  let i = 0;
  // skip WEBVTT header
  if (lines[0]?.startsWith("WEBVTT")) {
    while (i < lines.length && lines[i] !== "") i++;
    i++;
  }

  while (i < lines.length) {
    // skip blank lines & optional cue identifiers
    while (i < lines.length && !CUE_TIME_RE.test(lines[i]!)) {
      i++;
    }
    if (i >= lines.length) break;

    const m = CUE_TIME_RE.exec(lines[i]!)!;
    const start = parseTime(m[1]!);
    const end = parseTime(m[2]!);
    i++;

    const textLines: string[] = [];
    while (i < lines.length && lines[i] !== "") {
      textLines.push(lines[i]!);
      i++;
    }
    const cueText = cleanCueText(textLines.join(" "));
    if (cueText && Number.isFinite(start) && Number.isFinite(end)) {
      segments.push({ start, end, text: cueText });
    }
  }

  return segments;
}
