import { describe, expect, it } from "bun:test";
import { buildFetchArgs } from "./fetch-subtitles.ts";

describe("buildFetchArgs", () => {
  it("强制要求 YouTube 按繁中返回标题/描述，避免抓到英文自动翻译版本", () => {
    const args = buildFetchArgs("https://youtu.be/abc", "/tmp/subs/%(id)s.%(ext)s", "/tmp/info/%(id)s.%(ext)s");
    const i = args.indexOf("--extractor-args");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toContain("lang=zh-TW");
  });

  it("仍然请求所有优先语言的字幕", () => {
    const args = buildFetchArgs("https://youtu.be/abc", "/s/%(id)s.%(ext)s", "/i/%(id)s.%(ext)s");
    const i = args.indexOf("--sub-langs");
    expect(i).toBeGreaterThanOrEqual(0);
    const langs = args[i + 1]!;
    expect(langs).toContain("zh-Hans");
    expect(langs).toContain("zh-Hant");
  });
});
