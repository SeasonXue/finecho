import { describe, expect, it } from "bun:test";
import { buildListArgs } from "./list-videos.ts";

describe("buildListArgs", () => {
  it("强制要求 YouTube 返回中文标题，避免 flat-playlist 返回英文自动翻译", () => {
    const args = buildListArgs("https://www.youtube.com/@yutinghaofinance/streams");
    const i = args.indexOf("--extractor-args");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toContain("lang=zh-TW");
  });

  it("保留原有 flat-playlist / dump-json 行为", () => {
    const args = buildListArgs("https://example.com");
    expect(args).toContain("--flat-playlist");
    expect(args).toContain("--dump-json");
    expect(args[args.length - 1]).toBe("https://example.com");
  });
});
