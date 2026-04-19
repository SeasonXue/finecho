import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { getChannel } from "../channels.ts";
import * as log from "../lib/logger.ts";
import { corpusDbPath, runBuildIndex } from "../clone/index-build.ts";
import { runRepl, runOnce } from "../clone/repl.ts";

export interface CloneOptions {
  channelSlug?: string;
  model?: string;
  once?: string;
}

export async function runClone(opts: CloneOptions): Promise<void> {
  const channel = getChannel(opts.channelSlug);
  const dbPath = corpusDbPath(channel.slug);
  if (!existsSync(dbPath)) {
    log.error(
      `索引未构建: ${dbPath}\n请先跑 \`bun run clone:build-index\`。`,
    );
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: true });

  if (opts.once) {
    await runOnce({ db, model: opts.model }, opts.once);
  } else {
    await runRepl({ db, model: opts.model });
  }
  db.close();
}

export interface CloneBuildIndexCliOptions {
  channelSlug?: string;
  force?: boolean;
}

export async function runCloneBuildIndex(
  opts: CloneBuildIndexCliOptions,
): Promise<void> {
  await runBuildIndex({ channelSlug: opts.channelSlug, force: opts.force });
}
