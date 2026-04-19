import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { PIPELINE_VERSION } from "../types.ts";
import { channelPaths } from "../lib/paths.ts";
import { getChannel } from "../channels.ts";
import * as log from "../lib/logger.ts";
import {
  initSchema,
  insertVideo,
  readMeta,
  tokenizeForIndex,
  type VideoRow,
} from "./retrieval.ts";

export function cloneDir(slug: string): string {
  const paths = channelPaths(slug);
  return join(paths.base, "clone");
}

export function corpusDbPath(slug: string): string {
  return join(cloneDir(slug), "corpus.sqlite");
}

interface VideoJsonl {
  id: string;
  title: string;
  url: string;
  uploadDate: string;
  duration: number | null;
  segmentCount: number;
  charCount: number;
  text: string;
}

interface SegmentJsonl {
  videoId: string;
  uploadDate: string;
  index: number;
  start: number;
  end: number;
  text: string;
}

async function* readJsonlLines<T>(path: string): AsyncGenerator<T> {
  const file = Bun.file(path);
  const stream = file.stream();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line) as T;
      nl = buf.indexOf("\n");
    }
  }
  buf += decoder.decode();
  const tail = buf.trim();
  if (tail) yield JSON.parse(tail) as T;
}

export interface BuildIndexOptions {
  channelSlug?: string;
  /** 强制删库重建（默认仅在 pipeline_version 不匹配时重建） */
  force?: boolean;
}

export async function runBuildIndex(opts: BuildIndexOptions = {}): Promise<void> {
  const channel = getChannel(opts.channelSlug);
  const paths = channelPaths(channel.slug);
  const dbPath = corpusDbPath(channel.slug);

  const videosPath = join(paths.corpusJsonl, "videos.jsonl");
  const segmentsPath = join(paths.corpusJsonl, "segments.jsonl");
  if (!existsSync(videosPath) || !existsSync(segmentsPath)) {
    log.error(
      `corpus/jsonl 未生成；先跑 \`bun run rebuild\` 或 \`bun run fetch\``,
    );
    process.exit(1);
  }

  await mkdir(dirname(dbPath), { recursive: true });

  if (opts.force && existsSync(dbPath)) {
    await rm(dbPath);
  } else if (existsSync(dbPath)) {
    const probe = new Database(dbPath);
    const stored = safeReadVersion(probe);
    probe.close();
    if (stored !== PIPELINE_VERSION) {
      log.info(
        `pipeline_version 从 ${stored ?? "(空)"} → ${PIPELINE_VERSION}，重建索引`,
      );
      await rm(dbPath);
    }
  }

  const db = new Database(dbPath);
  initSchema(db);

  // 灌视频
  let videoCount = 0;
  const insertVideos = db.transaction((rows: VideoRow[]) => {
    for (const v of rows) insertVideo(db, v);
  });
  const videoBatch: VideoRow[] = [];
  for await (const row of readJsonlLines<VideoJsonl>(videosPath)) {
    videoBatch.push({
      id: row.id,
      title: row.title,
      url: row.url,
      uploadDate: row.uploadDate,
      duration: row.duration,
      segmentCount: row.segmentCount,
      charCount: row.charCount,
      fullText: row.text,
    });
    if (videoBatch.length >= 200) {
      insertVideos(videoBatch.splice(0));
    }
    videoCount++;
  }
  if (videoBatch.length > 0) insertVideos(videoBatch);
  log.info(`videos: ${videoCount}`);

  // 灌 segments（批量 + 事务）。JSONL 若有历史追加产生的 (videoId, idx) 重复，
  // 用 INSERT OR IGNORE 跳过；RETURNING 对被忽略的行返回 null。
  const insSeg = db.prepare(
    `INSERT OR IGNORE INTO segments
       (videoId, idx, startSec, endSec, uploadDate, text)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING id`,
  );
  const insFts = db.prepare(
    `INSERT INTO segments_fts (rowid, searchText) VALUES (?, ?)`,
  );
  let skipped = 0;
  const insertSegBatch = db.transaction((rows: SegmentJsonl[]) => {
    for (const r of rows) {
      const got = insSeg.get(
        r.videoId,
        r.index,
        r.start,
        r.end,
        r.uploadDate,
        r.text,
      ) as { id: number } | null;
      if (!got) {
        skipped++;
        continue;
      }
      insFts.run(got.id, tokenizeForIndex(r.text));
    }
  });

  let segCount = 0;
  let segBatch: SegmentJsonl[] = [];
  const BATCH = 5000;
  for await (const seg of readJsonlLines<SegmentJsonl>(segmentsPath)) {
    segBatch.push(seg);
    segCount++;
    if (segBatch.length >= BATCH) {
      insertSegBatch(segBatch);
      segBatch = [];
      log.progress(`indexing segments... ${segCount}`);
    }
  }
  if (segBatch.length > 0) insertSegBatch(segBatch);
  log.progressEnd();
  if (skipped > 0) {
    log.warn(`跳过 ${skipped} 条 (videoId, idx) 重复的 segment（历史 append 产物）`);
  }

  db.run(
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('pipeline_version', ?)`,
    [PIPELINE_VERSION],
  );
  db.run(
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('built_at', ?)`,
    [new Date().toISOString()],
  );

  // 统计
  const videoRowCount = (db.query(`SELECT COUNT(*) c FROM videos`).get() as {
    c: number;
  }).c;
  const segRowCount = (db.query(`SELECT COUNT(*) c FROM segments`).get() as {
    c: number;
  }).c;

  db.close();

  log.success(
    `索引构建完成: ${videoRowCount} videos, ${segRowCount} segments → ${dbPath}`,
  );
}

function safeReadVersion(db: Database): string | null {
  try {
    return readMeta(db, "pipeline_version");
  } catch {
    return null;
  }
}
