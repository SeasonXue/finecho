import { describe, expect, it } from "bun:test";
import { sep } from "node:path";
import {
  CHANNELS_ROOT,
  channelDir,
  channelPaths,
  formatUploadDate,
  safeFileName,
  yearMonthSegments,
} from "./paths.ts";

describe("channelDir", () => {
  it("拼到 CHANNELS_ROOT 下", () => {
    expect(channelDir("yutinghaofinance")).toBe(
      `${CHANNELS_ROOT}${sep}yutinghaofinance`,
    );
  });
});

describe("channelPaths", () => {
  it("返回所有派生路径，全部位于 base 之下", () => {
    const slug = "yutinghaofinance";
    const p = channelPaths(slug);
    expect(p.base).toBe(channelDir(slug));
    const expectedSuffixes: Array<[keyof typeof p, string]> = [
      ["channelJson", "channel.json"],
      ["videosJsonl", "videos.jsonl"],
      ["manifestJson", "manifest.json"],
      ["rawSubtitles", `raw${sep}subtitles`],
      ["rawAudio", `raw${sep}audio`],
      ["rawVideoInfo", `raw${sep}video-info`],
      ["processedTranscripts", `processed${sep}transcripts`],
      ["corpusMarkdown", `corpus${sep}markdown`],
      ["corpusJsonl", `corpus${sep}jsonl`],
    ];
    for (const [key, suffix] of expectedSuffixes) {
      expect(p[key]).toBe(`${p.base}${sep}${suffix}`);
    }
  });
});

describe("safeFileName", () => {
  it("替换 Windows/POSIX 保留字符为下划线", () => {
    expect(safeFileName("a/b\\c:d*e?f\"g<h>i|j")).toBe(
      "a_b_c_d_e_f_g_h_i_j",
    );
  });

  it("合并连续空白并 trim", () => {
    expect(safeFileName("  hello   world  ")).toBe("hello world");
  });

  it("中文短标题原样保留", () => {
    expect(safeFileName("游庭皓的财经皓角")).toBe("游庭皓的财经皓角");
  });

  it("超过长度上限按 code point 截断（不切坏中文）", () => {
    const title = "甲".repeat(100);
    const out = safeFileName(title, 80);
    expect([...out]).toHaveLength(80);
    expect(out).toBe("甲".repeat(80));
  });

  it("自定义长度上限生效", () => {
    expect(safeFileName("abcdefghij", 5)).toBe("abcde");
  });

  it("含 emoji 也按 code point 计数（不切碎代理对）", () => {
    const title = "🐂".repeat(50);
    const out = safeFileName(title, 10);
    expect([...out]).toHaveLength(10);
    expect(out).toBe("🐂".repeat(10));
  });

  it("空字符串与全空白 trim 后为空", () => {
    expect(safeFileName("")).toBe("");
    expect(safeFileName("    ")).toBe("");
  });
});

describe("formatUploadDate", () => {
  it("YYYYMMDD 转为 YYYY-MM-DD", () => {
    expect(formatUploadDate("20260419")).toBe("2026-04-19");
  });

  it("非 8 位数字原样返回", () => {
    expect(formatUploadDate("2026-04-19")).toBe("2026-04-19");
    expect(formatUploadDate("unknown")).toBe("unknown");
    expect(formatUploadDate("2026041")).toBe("2026041");
    expect(formatUploadDate("202604190")).toBe("202604190");
  });
});

describe("yearMonthSegments", () => {
  it("从 YYYY-MM-DD 切出年与年月", () => {
    expect(yearMonthSegments("2026-04-19")).toEqual({
      year: "2026",
      yearMonth: "2026-04",
    });
  });
});
