import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Manifest, ManifestEntry, SkippedEntry } from "../types.ts";

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
  manifest.lastRun = new Date().toISOString();
  await Bun.write(path, JSON.stringify(manifest, null, 2) + "\n");
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
