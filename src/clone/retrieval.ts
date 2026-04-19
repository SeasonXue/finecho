import { Database } from "bun:sqlite";
import { PIPELINE_VERSION } from "../types.ts";

export interface VideoRow {
  id: string;
  title: string;
  url: string;
  uploadDate: string;
  duration: number | null;
  segmentCount: number;
  charCount: number;
  fullText: string;
}

export interface SegmentInput {
  start: number;
  end: number;
  text: string;
}

export interface SearchHit {
  videoId: string;
  videoTitle: string;
  videoUrl: string;
  uploadDate: string;
  idx: number;
  startSec: number;
  endSec: number;
  text: string;
  /** YouTube 带时间戳链接，用户/Agent 引用时直接可点 */
  sourceUrl: string;
}

export interface SearchOptions {
  query: string;
  limit?: number;
  /** YYYY-MM-DD，仅保留 uploadDate >= sinceDate 的结果 */
  sinceDate?: string;
}

export interface DateRangeOptions {
  /** YYYY-MM-DD inclusive */
  start: string;
  /** YYYY-MM-DD inclusive */
  end: string;
}

export interface GetVideoOptions {
  videoId: string;
  /** 截断 fullText 至前 N 个 code point（中文安全） */
  maxChars?: number;
}

const DEFAULT_SEARCH_LIMIT = 8;

export function initSchema(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      uploadDate TEXT NOT NULL,
      duration INTEGER,
      segmentCount INTEGER NOT NULL,
      charCount INTEGER NOT NULL,
      fullText TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_videos_uploadDate ON videos(uploadDate);

    -- segments 是真实表：支持按 (videoId, idx) 做 O(logN) 的上下文窗口查询。
    CREATE TABLE IF NOT EXISTS segments (
      id INTEGER PRIMARY KEY,
      videoId TEXT NOT NULL,
      idx INTEGER NOT NULL,
      startSec REAL NOT NULL,
      endSec REAL NOT NULL,
      uploadDate TEXT NOT NULL,
      text TEXT NOT NULL,
      UNIQUE (videoId, idx)
    );
    CREATE INDEX IF NOT EXISTS idx_segments_videoId_idx ON segments(videoId, idx);
    CREATE INDEX IF NOT EXISTS idx_segments_uploadDate ON segments(uploadDate);

    -- FTS5 是独立的 contentless 索引。unicode61 不切 CJK，所以我们把原文按 code
    -- point 拆成空格分隔的字流存进 searchText 让分词器能正确建索引；查询时走同
    -- 样的字流转换拼 phrase。
    CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
      searchText,
      content='',
      tokenize='unicode61'
    );
  `);
  db.run(
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('pipeline_version', ?)`,
    [PIPELINE_VERSION],
  );
}

export function insertVideo(db: Database, v: VideoRow): void {
  db.run(
    `INSERT OR REPLACE INTO videos
       (id, title, url, uploadDate, duration, segmentCount, charCount, fullText)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      v.id,
      v.title,
      v.url,
      v.uploadDate,
      v.duration,
      v.segmentCount,
      v.charCount,
      v.fullText,
    ],
  );
}

export function insertSegments(
  db: Database,
  videoId: string,
  uploadDate: string,
  segments: SegmentInput[],
  startIdx = 0,
): void {
  const insSeg = db.prepare(
    `INSERT INTO segments (videoId, idx, startSec, endSec, uploadDate, text)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING id`,
  );
  const insFts = db.prepare(
    `INSERT INTO segments_fts (rowid, searchText) VALUES (?, ?)`,
  );
  const insertMany = db.transaction((rows: SegmentInput[]) => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const { id } = insSeg.get(
        videoId,
        startIdx + i,
        row.start,
        row.end,
        uploadDate,
        row.text,
      ) as { id: number };
      insFts.run(id, tokenizeForIndex(row.text));
    }
  });
  insertMany(segments);
}

/**
 * 把原文转成空格分隔的「字流」供 unicode61 分词器索引。
 * CJK/假名/韩字等每个 code point 加前后空格；ASCII 单词保持原样。
 */
export function tokenizeForIndex(s: string): string {
  return s
    .replace(
      /([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af])/g,
      " $1 ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** 转成 FTS5 phrase AND 查询：CJK 按字拆，ASCII 按原词，每 token 独立 phrase 然后 AND。 */
export function buildFtsQuery(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("buildFtsQuery: empty query");
  }
  const tokens = tokenizeForIndex(trimmed).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("buildFtsQuery: no tokens");
  }
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

export function youtubeTimeUrl(url: string, startSec: number): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${Math.floor(startSec)}s`;
}

interface RawSegmentHit {
  videoId: string;
  idx: number;
  startSec: number;
  endSec: number;
  uploadDate: string;
  text: string;
}

export function searchSegments(
  db: Database,
  opts: SearchOptions,
): SearchHit[] {
  const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
  const fts = buildFtsQuery(opts.query);

  // 过度 fetch 一点以便 sinceDate 过滤后仍能凑够 limit。
  const fetchLimit = opts.sinceDate ? Math.max(limit * 4, 32) : limit;

  const rows = db
    .query(
      `SELECT s.videoId, s.idx, s.startSec, s.endSec, s.uploadDate, s.text
       FROM segments_fts fts
       JOIN segments s ON s.id = fts.rowid
       WHERE segments_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(fts, fetchLimit) as RawSegmentHit[];

  const filtered = opts.sinceDate
    ? rows.filter((r) => r.uploadDate >= opts.sinceDate!)
    : rows;

  const capped = filtered.slice(0, limit);
  if (capped.length === 0) return [];

  const videoIds = [...new Set(capped.map((r) => r.videoId))];
  const placeholders = videoIds.map(() => "?").join(",");
  const videos = db
    .query(
      `SELECT id, title, url FROM videos WHERE id IN (${placeholders})`,
    )
    .all(...videoIds) as Array<{ id: string; title: string; url: string }>;
  const videoMap = new Map(videos.map((v) => [v.id, v]));

  return capped.map((r) => {
    const v = videoMap.get(r.videoId);
    const videoTitle = v?.title ?? "";
    const videoUrl = v?.url ?? "";
    return {
      videoId: r.videoId,
      videoTitle,
      videoUrl,
      uploadDate: r.uploadDate,
      idx: r.idx,
      startSec: r.startSec,
      endSec: r.endSec,
      text: r.text,
      sourceUrl: videoUrl ? youtubeTimeUrl(videoUrl, r.startSec) : "",
    };
  });
}

/**
 * 取某个 segment 的上下文窗口（前后若干句），用来扩出一段有语境的片段。
 * 返回按 idx 升序的连续段落。
 */
export function getSegmentContext(
  db: Database,
  opts: { videoId: string; idx: number; before?: number; after?: number },
): Array<{ idx: number; startSec: number; endSec: number; text: string }> {
  const before = opts.before ?? 1;
  const after = opts.after ?? 2;
  return db
    .query(
      `SELECT idx, startSec, endSec, text
       FROM segments
       WHERE videoId = ? AND idx BETWEEN ? AND ?
       ORDER BY idx`,
    )
    .all(opts.videoId, opts.idx - before, opts.idx + after) as Array<{
    idx: number;
    startSec: number;
    endSec: number;
    text: string;
  }>;
}

export function listVideosByDate(
  db: Database,
  opts: DateRangeOptions,
): VideoRow[] {
  return db
    .query(
      `SELECT id, title, url, uploadDate, duration, segmentCount, charCount, fullText
       FROM videos
       WHERE uploadDate >= ? AND uploadDate <= ?
       ORDER BY uploadDate ASC`,
    )
    .all(opts.start, opts.end) as VideoRow[];
}

export function getVideo(db: Database, opts: GetVideoOptions): VideoRow | null {
  const row = db
    .query(
      `SELECT id, title, url, uploadDate, duration, segmentCount, charCount, fullText
       FROM videos WHERE id = ?`,
    )
    .get(opts.videoId) as VideoRow | null;
  if (!row) return null;
  if (opts.maxChars != null && opts.maxChars >= 0) {
    // 按 code point 截断，中文安全
    const cps = Array.from(row.fullText);
    if (cps.length > opts.maxChars) {
      row.fullText = cps.slice(0, opts.maxChars).join("");
    }
  }
  return row;
}

export function openCorpus(path: string): Database {
  const db = new Database(path);
  return db;
}

export function readMeta(db: Database, key: string): string | null {
  const row = db
    .query(`SELECT value FROM meta WHERE key = ?`)
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}
