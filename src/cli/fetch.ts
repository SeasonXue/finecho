import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PIPELINE_VERSION, type ProcessedTranscript, type VideoMeta } from "../types.ts";
import { channelPaths } from "../lib/paths.ts";
import { pLimit } from "../lib/concurrency.ts";
import * as log from "../lib/logger.ts";
import {
  ensureChannelJson,
  isProcessed,
  loadManifest,
  markProcessed,
  markSkipped,
  saveManifest,
  shouldRetrySkipped,
} from "../lib/manifest.ts";
import { getChannel } from "../channels.ts";
import { listLiveStreams, writeVideosJsonl } from "../pipeline/list-videos.ts";
import { fetchSubtitles } from "../pipeline/fetch-subtitles.ts";
import { parseVtt } from "../pipeline/parse-vtt.ts";
import { dedupeRollingSegments } from "../pipeline/normalize.ts";
import {
  appendToCorpusJsonl,
  resetCorpusJsonl,
  writeMarkdown,
  writeProcessed,
} from "../pipeline/render.ts";

interface FetchOptions {
  limit?: number;
  force?: boolean;
  concurrency?: number;
  channelSlug?: string;
}

export async function runFetch(opts: FetchOptions): Promise<void> {
  const channel = getChannel(opts.channelSlug);
  const paths = channelPaths(channel.slug);
  await mkdir(paths.base, { recursive: true });

  await ensureChannelJson(paths.channelJson, channel);

  log.info(`[${channel.slug}] listing live streams …`);
  const videos = await listLiveStreams(channel.url);
  log.success(`found ${videos.length} live streams`);
  await writeVideosJsonl(paths.videosJsonl, videos);

  const manifest = await loadManifest(paths.manifestJson, channel.url, channel.slug);

  const now = new Date();
  const todo: VideoMeta[] = [];
  let retrying = 0;
  for (const v of videos) {
    if (opts.force) {
      todo.push(v);
      continue;
    }
    if (isProcessed(manifest, v.id)) continue;
    const skipped = manifest.skipped[v.id];
    if (skipped) {
      if (!shouldRetrySkipped(skipped, now)) continue;
      retrying++;
    }
    todo.push(v);
  }
  if (opts.limit != null) todo.splice(opts.limit);

  log.info(
    `${todo.length} to process (already done: ${Object.keys(manifest.videos).length}, skipped: ${Object.keys(manifest.skipped).length}, retrying: ${retrying})`,
  );
  if (todo.length === 0) {
    // 没活儿干就不动 manifest 文件，避免 CI 产生"只改 lastRun"的空 commit。
    return;
  }

  // append-only JSONL: only reset on --force
  if (opts.force) {
    await resetCorpusJsonl(paths.corpusJsonl);
  }

  const limit = pLimit(opts.concurrency ?? 3);
  let done = 0;
  let skipped = 0;
  const total = todo.length;

  const tasks = todo.map((video) =>
    limit(async () => {
      try {
        const track = await fetchSubtitles(video, paths.rawSubtitles, paths.rawVideoInfo);
        if (!track) {
          markSkipped(manifest, video.id, {
            reason: "no-subtitles",
            lastTriedAt: new Date().toISOString(),
          });
          skipped++;
          log.progress(`[${done + skipped}/${total}] skip ${video.id} (no subs)`);
          return;
        }

        const rawSegments = await parseVtt(track.vttPath);
        const segments = dedupeRollingSegments(rawSegments);
        if (segments.length === 0) {
          markSkipped(manifest, video.id, {
            reason: "parse-failed",
            lastTriedAt: new Date().toISOString(),
            message: "zero segments after normalize",
          });
          skipped++;
          return;
        }

        // enrich video meta from info.json if available (duration, accurate date)
        const infoPath = join(paths.rawVideoInfo, `${video.id}.info.json`);
        const info = (await Bun.file(infoPath).json().catch(() => null)) as
          | { upload_date?: string; release_date?: string; duration?: number; title?: string }
          | null;
        const uploadDate =
          video.uploadDate ||
          formatDate(info?.upload_date) ||
          formatDate(info?.release_date) ||
          "unknown-date";
        const duration = video.duration ?? info?.duration;
        // prefer info.json's canonical title over flat-playlist title
        // (yt-dlp's flat-playlist sometimes returns YouTube's auto-translated titles)
        const title = info?.title || video.title || video.id;

        const processed: ProcessedTranscript = {
          id: video.id,
          title,
          url: video.url,
          uploadDate,
          duration,
          subtitleLang: track.lang,
          subtitleSource: track.source,
          segments,
          processedAt: new Date().toISOString(),
          pipelineVersion: PIPELINE_VERSION,
        };

        await writeProcessed(paths.processedTranscripts, processed);
        const mdRel = await writeMarkdown(paths.corpusMarkdown, processed);
        await appendToCorpusJsonl(paths.corpusJsonl, processed);

        markProcessed(manifest, video.id, {
          title,
          url: video.url,
          uploadDate,
          duration,
          processedPath: join("processed/transcripts", `${video.id}.json`),
          markdownPath: join("corpus/markdown", mdRel),
          subtitleLang: track.lang,
          subtitleSource: track.source,
          downloadedAt: new Date().toISOString(),
          pipelineVersion: PIPELINE_VERSION,
        });
        done++;
        log.progress(`[${done + skipped}/${total}] ${video.id} ${track.source} ${track.lang} ← ${uploadDate}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        markSkipped(manifest, video.id, {
          reason: "fetch-failed",
          lastTriedAt: new Date().toISOString(),
          message,
        });
        skipped++;
        log.progressEnd();
        log.warn(`${video.id}: ${message}`);
      }
      // persist every N items for resilience
      if ((done + skipped) % 10 === 0) {
        manifest.lastRun = new Date().toISOString();
        await saveManifest(paths.manifestJson, manifest);
      }
    }),
  );

  await Promise.all(tasks);
  log.progressEnd();
  manifest.lastRun = new Date().toISOString();
  await saveManifest(paths.manifestJson, manifest);

  log.success(`fetch done: ${done} processed, ${skipped} skipped`);
}

function formatDate(raw?: string): string {
  if (!raw) return "";
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return raw;
}
