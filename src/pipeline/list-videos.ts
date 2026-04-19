import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { VideoMeta } from "../types.ts";
import { ytDlpJsonLines } from "../lib/yt-dlp.ts";
import { formatUploadDate } from "../lib/paths.ts";

/**
 * 枚举频道 /streams Tab 全部历史直播。
 * 使用 --flat-playlist 避免对每个视频发起独立请求，速度快。
 * 注意：flat-playlist 下 upload_date/duration 可能缺失，后续下字幕时再补。
 */
export function buildListArgs(channelStreamsUrl: string): string[] {
  return [
    "--flat-playlist",
    "--dump-json",
    "--ignore-errors",
    "--no-warnings",
    // YouTube 会按客户端语言自动翻译标题；强制 hl=zh-TW，拿到博主原始繁中标题。
    // 注意：yt-dlp 此处只接受 YouTube 自家的 lang code（zh-TW / zh-CN / zh-HK），不认 BCP47。
    "--extractor-args",
    "youtube:lang=zh-TW",
    channelStreamsUrl,
  ];
}

export async function listLiveStreams(channelStreamsUrl: string): Promise<VideoMeta[]> {
  const args = buildListArgs(channelStreamsUrl);

  const videos: VideoMeta[] = [];
  for await (const raw of ytDlpJsonLines(args)) {
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : undefined;
    const title = typeof r.title === "string" ? r.title : undefined;
    if (!id || !title) continue;

    const url =
      typeof r.url === "string" && r.url.startsWith("http")
        ? r.url
        : `https://www.youtube.com/watch?v=${id}`;

    const uploadDateRaw =
      typeof r.upload_date === "string"
        ? r.upload_date
        : typeof r.release_date === "string"
        ? r.release_date
        : "";
    const uploadDate = uploadDateRaw ? formatUploadDate(uploadDateRaw) : "";

    const duration = typeof r.duration === "number" ? r.duration : undefined;

    videos.push({ id, title, url, uploadDate, duration });
  }
  return videos;
}

export async function writeVideosJsonl(path: string, videos: VideoMeta[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lines = videos.map((v) => JSON.stringify(v)).join("\n") + "\n";
  await Bun.write(path, lines);
}
