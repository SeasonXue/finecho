import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Manifest, ManifestEntry, SkippedEntry } from "../types.ts";

/** 暂时性失败的冷却期：3 天。weekdays CI 触发时，失败后会在下一个工作日左右自然重试。 */
export const TRANSIENT_SKIP_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

const PERMANENT_SKIP_REASONS: ReadonlySet<SkippedEntry["reason"]> = new Set(["no-subtitles"]);

/**
 * 是否应该重试一个被 skip 的视频。
 * - `no-subtitles` 视作永久失败（YouTube 侧根本没字幕轨，重抓也是浪费）。
 * - 其余（`fetch-failed` / `parse-failed`）视作暂时失败，超过冷却期就重试一次。
 * - `lastTriedAt` 无法解析时返回 true（宁可重试，不要永久卡死）。
 */
export function shouldRetrySkipped(
  entry: SkippedEntry,
  now: Date,
  cooldownMs: number = TRANSIENT_SKIP_COOLDOWN_MS,
): boolean {
  if (PERMANENT_SKIP_REASONS.has(entry.reason)) return false;
  const last = Date.parse(entry.lastTriedAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= cooldownMs;
}

export async function loadManifest(path: string, channelUrl: string, channelSlug: string): Promise<Manifest> {
  if (!existsSync(path)) {
    return { channelUrl, channelSlug, videos: {}, skipped: {} };
  }
  const text = await Bun.file(path).text();
  try {
    const parsed = JSON.parse(text) as Manifest;
    parsed.videos ??= {};
    parsed.skipped ??= {};
    return parsed;
  } catch {
    return { channelUrl, channelSlug, videos: {}, skipped: {} };
  }
}

export async function saveManifest(path: string, manifest: Manifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * 只在首次落盘时写 channel.json，含 `firstSeenAt = now`；
 * 已存在则原样保留（避免每次 fetch 都覆盖时间戳、制造无意义的 diff）。
 */
export async function ensureChannelJson(
  path: string,
  channel: { slug: string; name: string; url: string },
  now: Date = new Date(),
): Promise<void> {
  if (existsSync(path)) return;
  await mkdir(dirname(path), { recursive: true });
  const payload = {
    slug: channel.slug,
    name: channel.name,
    url: channel.url,
    firstSeenAt: now.toISOString(),
  };
  await Bun.write(path, JSON.stringify(payload, null, 2) + "\n");
}

export function isProcessed(manifest: Manifest, videoId: string): boolean {
  return Boolean(manifest.videos[videoId]);
}

export function isSkipped(manifest: Manifest, videoId: string): boolean {
  return Boolean(manifest.skipped[videoId]);
}

export function markProcessed(manifest: Manifest, id: string, entry: ManifestEntry): void {
  manifest.videos[id] = entry;
  delete manifest.skipped[id];
}

export function markSkipped(manifest: Manifest, id: string, entry: SkippedEntry): void {
  manifest.skipped[id] = entry;
}
