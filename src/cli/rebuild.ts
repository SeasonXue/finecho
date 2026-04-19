import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { PIPELINE_VERSION, type ProcessedTranscript, type SubtitleSource } from "../types.ts";
import { channelPaths, formatUploadDate } from "../lib/paths.ts";
import * as log from "../lib/logger.ts";
import { getChannel } from "../channels.ts";
import { parseVtt } from "../pipeline/parse-vtt.ts";
import { dedupeRollingSegments } from "../pipeline/normalize.ts";
import {
  appendToCorpusJsonl,
  resetCorpusJsonl,
  writeMarkdown,
  writeProcessed,
} from "../pipeline/render.ts";
import { LANG_PRIORITY } from "../pipeline/fetch-subtitles.ts";
import { loadManifest, markProcessed, saveManifest } from "../lib/manifest.ts";

interface RebuildOptions {
  channelSlug?: string;
}

/**
 * 不请求 YouTube，仅依赖已有 raw/subtitles + raw/video-info 重跑 processed/ 与 corpus/。
 * normalize/render 升级后用这个刷新派生数据。
 */
export async function runRebuild(opts: RebuildOptions): Promise<void> {
  const channel = getChannel(opts.channelSlug);
  const paths = channelPaths(channel.slug);

  if (!existsSync(paths.rawSubtitles)) {
    log.error(`raw/subtitles/ not found for ${channel.slug}; run fetch first`);
    process.exit(1);
  }

  const vttFiles = (await readdir(paths.rawSubtitles)).filter((f) => f.endsWith(".vtt"));
  const byVideo = groupByVideoId(vttFiles);

  log.info(`rebuilding from ${Object.keys(byVideo).length} videos in raw/`);
  await resetCorpusJsonl(paths.corpusJsonl);
  const manifest = await loadManifest(paths.manifestJson, channel.url, channel.slug);

  let ok = 0;
  let fail = 0;

  for (const [videoId, langFiles] of Object.entries(byVideo)) {
    const infoPath = join(paths.rawVideoInfo, `${videoId}.info.json`);
    if (!existsSync(infoPath)) {
      log.warn(`${videoId}: missing info.json, skipping`);
      fail++;
      continue;
    }
    const info = (await Bun.file(infoPath).json()) as {
      title?: string;
      upload_date?: string;
      release_date?: string;
      duration?: number;
      subtitles?: Record<string, unknown[]>;
      automatic_captions?: Record<string, unknown[]>;
    };

    const track = pickFromFiles(videoId, langFiles, info);
    if (!track) {
      log.warn(`${videoId}: no usable subtitle file`);
      fail++;
      continue;
    }

    const vttPath = join(paths.rawSubtitles, `${videoId}.${track.lang}.vtt`);
    const rawSegments = await parseVtt(vttPath);
    const segments = dedupeRollingSegments(rawSegments);
    if (segments.length === 0) {
      log.warn(`${videoId}: zero segments after normalize`);
      fail++;
      continue;
    }

    const uploadDate =
      (info.upload_date && formatUploadDate(info.upload_date)) ||
      (info.release_date && formatUploadDate(info.release_date)) ||
      "unknown-date";

    const processed: ProcessedTranscript = {
      id: videoId,
      title: info.title ?? videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      uploadDate,
      duration: info.duration,
      subtitleLang: track.lang,
      subtitleSource: track.source,
      segments,
      processedAt: new Date().toISOString(),
      pipelineVersion: PIPELINE_VERSION,
    };

    await writeProcessed(paths.processedTranscripts, processed);
    const mdRel = await writeMarkdown(paths.corpusMarkdown, processed);
    await appendToCorpusJsonl(paths.corpusJsonl, processed);

    markProcessed(manifest, videoId, {
      title: processed.title,
      url: processed.url,
      uploadDate,
      duration: info.duration,
      processedPath: join("processed/transcripts", `${videoId}.json`),
      markdownPath: join("corpus/markdown", mdRel),
      subtitleLang: track.lang,
      subtitleSource: track.source,
      downloadedAt: new Date().toISOString(),
      pipelineVersion: PIPELINE_VERSION,
    });
    ok++;
  }

  await saveManifest(paths.manifestJson, manifest);
  log.success(`rebuild done: ${ok} ok, ${fail} failed`);
}

function groupByVideoId(vttFiles: string[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const f of vttFiles) {
    const dot = f.indexOf(".");
    if (dot <= 0) continue;
    const id = f.slice(0, dot);
    (map[id] ??= []).push(f);
  }
  return map;
}

function pickFromFiles(
  videoId: string,
  langFiles: string[],
  info: { subtitles?: Record<string, unknown[]>; automatic_captions?: Record<string, unknown[]> },
): { lang: string; source: SubtitleSource } | null {
  const onDisk = new Set(
    langFiles
      .map((f) => f.slice(videoId.length + 1, -".vtt".length))
      .filter(Boolean),
  );
  const manual = new Set(Object.keys(info.subtitles ?? {}));
  const auto = new Set(Object.keys(info.automatic_captions ?? {}));

  for (const preferred of LANG_PRIORITY) {
    if (onDisk.has(preferred) && manual.has(preferred)) return { lang: preferred, source: "manual" };
  }
  for (const preferred of LANG_PRIORITY) {
    if (onDisk.has(preferred) && auto.has(preferred)) return { lang: preferred, source: "auto" };
  }
  // 兜底：onDisk 里只要有任一优先级 lang 就用（没有 info.json 分类信息时）
  for (const preferred of LANG_PRIORITY) {
    if (onDisk.has(preferred)) return { lang: preferred, source: "auto" };
  }
  return null;
}
