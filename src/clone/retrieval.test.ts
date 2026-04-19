import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initSchema,
  insertVideo,
  insertSegments,
  searchSegments,
  listVideosByDate,
  getVideo,
  getSegmentContext,
  buildFtsQuery,
  youtubeTimeUrl,
} from "./retrieval.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  initSchema(db);
  return db;
}

function seedSample(db: Database): void {
  insertVideo(db, {
    id: "v_oil_0401",
    title: "2026/4/1 美伊將停戰 油價還不跌",
    url: "https://www.youtube.com/watch?v=v_oil_0401",
    uploadDate: "2026-04-01",
    duration: 1800,
    segmentCount: 3,
    charCount: 30,
    fullText: "投資朋友早安 今天我們談油價 油價跌不下來",
  });
  insertSegments(db, "v_oil_0401", "2026-04-01", [
    { start: 0, end: 5, text: "投資朋友早安" },
    { start: 5, end: 10, text: "今天我們談油價" },
    { start: 10, end: 15, text: "油價跌不下來" },
  ]);

  insertVideo(db, {
    id: "v_ai_0215",
    title: "2026/2/15 AI 撞牆期到了",
    url: "https://www.youtube.com/watch?v=v_ai_0215",
    uploadDate: "2026-02-15",
    duration: 2400,
    segmentCount: 2,
    charCount: 20,
    fullText: "AI 基建缺電缺料 台積電高預期魔咒",
  });
  insertSegments(db, "v_ai_0215", "2026-02-15", [
    { start: 0, end: 6, text: "AI 基建缺電缺料" },
    { start: 6, end: 12, text: "台積電高預期魔咒" },
  ]);

  insertVideo(db, {
    id: "v_gold_2512",
    title: "2025/12/22 黃金創史高",
    url: "https://www.youtube.com/watch?v=v_gold_2512",
    uploadDate: "2025-12-22",
    duration: 1500,
    segmentCount: 1,
    charCount: 12,
    fullText: "黃金創史高 多頭還能持續",
  });
  insertSegments(db, "v_gold_2512", "2025-12-22", [
    { start: 0, end: 8, text: "黃金創史高 多頭還能持續" },
  ]);
}

describe("buildFtsQuery", () => {
  it("中文逐字拆成 phrase 之后 AND", () => {
    expect(buildFtsQuery("油價")).toBe(`"油" "價"`);
  });

  it("ASCII 词保持完整不拆", () => {
    expect(buildFtsQuery("AI 基建")).toBe(`"AI" "基" "建"`);
  });

  it("去掉首尾空白", () => {
    expect(buildFtsQuery("  油價  ")).toBe(`"油" "價"`);
  });

  it("空字符串抛错（调用方应拦截）", () => {
    expect(() => buildFtsQuery("")).toThrow();
    expect(() => buildFtsQuery("   ")).toThrow();
  });
});

describe("youtubeTimeUrl", () => {
  it("附加 t 参数到 watch 链接", () => {
    expect(
      youtubeTimeUrl("https://www.youtube.com/watch?v=abc", 42.7),
    ).toBe("https://www.youtube.com/watch?v=abc&t=42s");
  });

  it("没有 query 时用 ?", () => {
    expect(youtubeTimeUrl("https://youtu.be/abc", 0)).toBe(
      "https://youtu.be/abc?t=0s",
    );
  });
});

describe("searchSegments", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
    seedSample(db);
  });

  it("关键词命中返回段落 + 来源链接", () => {
    const hits = searchSegments(db, { query: "油價", limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    const texts = hits.map((h) => h.text);
    expect(texts.some((t) => t.includes("油價"))).toBe(true);
    const first = hits[0]!;
    expect(first.videoId).toBe("v_oil_0401");
    expect(first.uploadDate).toBe("2026-04-01");
    expect(first.sourceUrl).toContain("&t=");
    expect(first.videoTitle).toContain("美伊將停戰");
  });

  it("无命中返回空数组", () => {
    const hits = searchSegments(db, { query: "不存在词ZZZ", limit: 5 });
    expect(hits).toEqual([]);
  });

  it("sinceDate 过滤掉之前的视频", () => {
    const hits = searchSegments(db, {
      query: "高",
      limit: 10,
      sinceDate: "2026-01-01",
    });
    for (const h of hits) {
      expect(h.uploadDate >= "2026-01-01").toBe(true);
    }
    // v_gold_2512 在 2025-12-22，应被过滤掉
    expect(hits.some((h) => h.videoId === "v_gold_2512")).toBe(false);
  });

  it("limit 生效", () => {
    insertSegments(
      db,
      "v_oil_0401",
      "2026-04-01",
      [
        { start: 20, end: 25, text: "油價再度跳漲" },
        { start: 25, end: 30, text: "油價壓不住了" },
        { start: 30, end: 35, text: "油價噴出" },
      ],
      3,
    );
    const hits = searchSegments(db, { query: "油價", limit: 2 });
    expect(hits.length).toBe(2);
  });
});

describe("listVideosByDate", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
    seedSample(db);
  });

  it("返回区间内的视频按日期升序", () => {
    const rows = listVideosByDate(db, {
      start: "2026-01-01",
      end: "2026-12-31",
    });
    expect(rows.map((r) => r.id)).toEqual(["v_ai_0215", "v_oil_0401"]);
  });

  it("区间外返回空", () => {
    const rows = listVideosByDate(db, {
      start: "2030-01-01",
      end: "2030-12-31",
    });
    expect(rows).toEqual([]);
  });

  it("端点包含（闭区间）", () => {
    const rows = listVideosByDate(db, {
      start: "2026-04-01",
      end: "2026-04-01",
    });
    expect(rows.map((r) => r.id)).toEqual(["v_oil_0401"]);
  });
});

describe("getVideo", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
    seedSample(db);
  });

  it("取到视频返回全文", () => {
    const v = getVideo(db, { videoId: "v_oil_0401" });
    expect(v).not.toBeNull();
    expect(v!.title).toContain("美伊將停戰");
    expect(v!.fullText).toContain("油價");
  });

  it("不存在返回 null", () => {
    const v = getVideo(db, { videoId: "not_exist" });
    expect(v).toBeNull();
  });

  it("maxChars 截断", () => {
    const v = getVideo(db, { videoId: "v_oil_0401", maxChars: 5 });
    expect(v).not.toBeNull();
    expect(v!.fullText.length).toBeLessThanOrEqual(5);
  });
});

describe("getSegmentContext", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
    seedSample(db);
  });

  it("返回命中前后连续段落（默认前 1 后 2）", () => {
    const ctx = getSegmentContext(db, { videoId: "v_oil_0401", idx: 1 });
    // 种子有 idx 0,1,2，默认 before=1/after=2 → 取 idx 0..3 ∩ 已有 → 0,1,2
    expect(ctx.map((c) => c.idx)).toEqual([0, 1, 2]);
    expect(ctx[0]!.text).toBe("投資朋友早安");
  });

  it("自定义窗口", () => {
    const ctx = getSegmentContext(db, {
      videoId: "v_oil_0401",
      idx: 2,
      before: 0,
      after: 0,
    });
    expect(ctx.map((c) => c.idx)).toEqual([2]);
  });

  it("不存在的 videoId 返回空", () => {
    const ctx = getSegmentContext(db, { videoId: "nope", idx: 0 });
    expect(ctx).toEqual([]);
  });
});
