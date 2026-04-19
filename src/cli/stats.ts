import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { channelPaths } from "../lib/paths.ts";
import { getChannel } from "../channels.ts";
import * as log from "../lib/logger.ts";
import type { ProcessedTranscript } from "../types.ts";

interface StatsOptions {
  channelSlug?: string;
}

export async function runStats(opts: StatsOptions): Promise<void> {
  const channel = getChannel(opts.channelSlug);
  const paths = channelPaths(channel.slug);
  if (!existsSync(paths.processedTranscripts)) {
    log.error("no processed/ data; run fetch first");
    process.exit(1);
  }

  const files = (await readdir(paths.processedTranscripts)).filter((f) => f.endsWith(".json"));

  let manual = 0;
  let auto = 0;
  let totalDuration = 0;
  let totalChars = 0;
  let totalSegments = 0;
  const byMonth: Record<string, number> = {};

  for (const f of files) {
    const t = (await Bun.file(join(paths.processedTranscripts, f)).json()) as ProcessedTranscript;
    if (t.subtitleSource === "manual") manual++;
    else auto++;
    if (t.duration) totalDuration += t.duration;
    totalSegments += t.segments.length;
    totalChars += t.segments.reduce((n, s) => n + s.text.length, 0);
    const ym = t.uploadDate.slice(0, 7);
    byMonth[ym] = (byMonth[ym] ?? 0) + 1;
  }

  log.info(`channel: ${channel.name} (${channel.slug})`);
  log.info(`videos processed: ${files.length}   manual subs: ${manual}   auto subs: ${auto}`);
  log.info(`total duration: ${(totalDuration / 3600).toFixed(1)} hours`);
  log.info(`total segments: ${totalSegments}`);
  log.info(`total chars: ${totalChars.toLocaleString()}`);
  log.info("by month:");
  for (const ym of Object.keys(byMonth).sort()) {
    log.info(`  ${ym}: ${byMonth[ym]}`);
  }
}
