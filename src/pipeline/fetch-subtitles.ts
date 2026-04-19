import { existsSync } from "node:fs";
import { readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SubtitleSource, SubtitleTrack, VideoMeta } from "../types.ts";
import { ytDlpRun, YtDlpError } from "../lib/yt-dlp.ts";

export const LANG_PRIORITY = ["zh-Hans", "zh-CN", "zh-Hant", "zh-TW", "zh"] as const;

/**
 * 下载一个视频的字幕到 rawSubtitlesDir，info.json 到 rawVideoInfoDir。
 * 不下视频本体。返回挑选后的最佳字幕轨；若无可用字幕则返回 null。
 */
export function buildFetchArgs(url: string, subsTemplate: string, infoTemplate: string): string[] {
  return [
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--write-info-json",
    "--sub-langs",
    LANG_PRIORITY.join(","),
    "--sub-format",
    "vtt",
    "--no-warnings",
    "--no-progress",
    // 同 list-videos：让 info.json 的 title/description 保持博主繁中原版。
    // yt-dlp 只接受 YouTube 自家的 lang code（zh-TW / zh-CN / zh-HK），不认 BCP47 zh-Hant。
    "--extractor-args",
    "youtube:lang=zh-TW",
    "-o",
    `subtitle:${subsTemplate}`,
    "-o",
    `infojson:${infoTemplate}`,
    url,
  ];
}

export async function fetchSubtitles(
  video: VideoMeta,
  rawSubtitlesDir: string,
  rawVideoInfoDir: string,
): Promise<SubtitleTrack | null> {
  await mkdir(rawSubtitlesDir, { recursive: true });
  await mkdir(rawVideoInfoDir, { recursive: true });

  const subsTemplate = join(rawSubtitlesDir, "%(id)s.%(ext)s");
  const infoTemplate = join(rawVideoInfoDir, "%(id)s.%(ext)s");

  const args = buildFetchArgs(video.url, subsTemplate, infoTemplate);

  await withRetry(() => ytDlpRun(args), { attempts: 3, baseDelayMs: 1500 });

  return pickBestSubtitle(video.id, rawSubtitlesDir, rawVideoInfoDir);
}

async function pickBestSubtitle(
  videoId: string,
  rawSubtitlesDir: string,
  rawVideoInfoDir: string,
): Promise<SubtitleTrack | null> {
  const infoPath = join(rawVideoInfoDir, `${videoId}.info.json`);
  if (!existsSync(infoPath)) return null;

  const info = (await Bun.file(infoPath).json()) as {
    subtitles?: Record<string, unknown[]>;
    automatic_captions?: Record<string, unknown[]>;
  };

  const manualLangs = new Set(Object.keys(info.subtitles ?? {}));
  const autoLangs = new Set(Object.keys(info.automatic_captions ?? {}));

  const files = (await readdir(rawSubtitlesDir)).filter(
    (f) => f.startsWith(`${videoId}.`) && f.endsWith(".vtt"),
  );
  const fileLangSet = new Set<string>();
  for (const f of files) {
    const lang = f.slice(videoId.length + 1, -".vtt".length);
    if (lang) fileLangSet.add(lang);
  }

  const pick = (langs: Set<string>, source: SubtitleSource): SubtitleTrack | null => {
    for (const preferred of LANG_PRIORITY) {
      if (langs.has(preferred) && fileLangSet.has(preferred)) {
        return {
          videoId,
          lang: preferred,
          source,
          vttPath: join(rawSubtitlesDir, `${videoId}.${preferred}.vtt`),
        };
      }
    }
    return null;
  };

  return pick(manualLangs, "manual") ?? pick(autoLangs, "auto");
}

interface RetryOpts {
  attempts: number;
  baseDelayMs: number;
}

async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err instanceof YtDlpError) {
        const msg = err.stderr.toLowerCase();
        if (msg.includes("video unavailable") || msg.includes("private video") || msg.includes("404")) {
          throw err;
        }
      }
      if (i < opts.attempts - 1) {
        await Bun.sleep(opts.baseDelayMs * Math.pow(2, i));
      }
    }
  }
  throw lastErr;
}
