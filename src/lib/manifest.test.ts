import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Manifest, SkippedEntry } from "../types.ts";
import {
  ensureChannelJson,
  loadManifest,
  saveManifest,
  shouldRetrySkipped,
  TRANSIENT_SKIP_COOLDOWN_MS,
} from "./manifest.ts";

const isoAgo = (now: Date, ms: number): string => new Date(now.getTime() - ms).toISOString();

function entry(reason: SkippedEntry["reason"], lastTriedAt: string): SkippedEntry {
  return { reason, lastTriedAt };
}

describe("shouldRetrySkipped", () => {
  const now = new Date("2026-04-19T10:00:00.000Z");

  it("no-subtitles 永不重试，哪怕很久以前", () => {
    expect(shouldRetrySkipped(entry("no-subtitles", "2020-01-01T00:00:00.000Z"), now)).toBe(false);
  });

  it("fetch-failed 在冷却期内不重试", () => {
    expect(shouldRetrySkipped(entry("fetch-failed", isoAgo(now, 60_000)), now)).toBe(false);
  });

  it("fetch-failed 超过冷却期则重试", () => {
    expect(
      shouldRetrySkipped(entry("fetch-failed", isoAgo(now, TRANSIENT_SKIP_COOLDOWN_MS + 1000)), now),
    ).toBe(true);
  });

  it("parse-failed 遵循同样的冷却期", () => {
    expect(
      shouldRetrySkipped(entry("parse-failed", isoAgo(now, TRANSIENT_SKIP_COOLDOWN_MS + 1000)), now),
    ).toBe(true);
    expect(shouldRetrySkipped(entry("parse-failed", isoAgo(now, 60_000)), now)).toBe(false);
  });

  it("恰好等于冷却期边界时重试（>=）", () => {
    expect(
      shouldRetrySkipped(entry("fetch-failed", isoAgo(now, TRANSIENT_SKIP_COOLDOWN_MS)), now),
    ).toBe(true);
  });

  it("lastTriedAt 无法解析时，走安全路线重试", () => {
    expect(shouldRetrySkipped(entry("fetch-failed", "not-a-date"), now)).toBe(true);
  });

  it("接受自定义冷却期参数", () => {
    const tenMinAgo = isoAgo(now, 10 * 60_000);
    expect(shouldRetrySkipped(entry("fetch-failed", tenMinAgo), now, 60 * 60_000)).toBe(false);
    expect(shouldRetrySkipped(entry("fetch-failed", tenMinAgo), now, 5 * 60_000)).toBe(true);
  });
});

describe("saveManifest", () => {
  async function withTmpManifest(
    fn: (path: string) => Promise<void>,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "manifest-test-"));
    try {
      await fn(join(dir, "manifest.json"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("不自动修改 lastRun（由调用方决定何时更新）", async () => {
    await withTmpManifest(async (path) => {
      const pinned = "2020-01-01T00:00:00.000Z";
      const manifest: Manifest = {
        channelUrl: "https://youtube.com/@x",
        channelSlug: "x",
        lastRun: pinned,
        videos: {},
        skipped: {},
      };
      await saveManifest(path, manifest);
      const reloaded = await loadManifest(path, "https://youtube.com/@x", "x");
      expect(reloaded.lastRun).toBe(pinned);
    });
  });

  it("manifest 无 lastRun 时保持 undefined，不偷偷塞一个当前时间", async () => {
    await withTmpManifest(async (path) => {
      const manifest: Manifest = {
        channelUrl: "https://youtube.com/@x",
        channelSlug: "x",
        videos: {},
        skipped: {},
      };
      await saveManifest(path, manifest);
      const reloaded = await loadManifest(path, "https://youtube.com/@x", "x");
      expect(reloaded.lastRun).toBeUndefined();
    });
  });
});

describe("ensureChannelJson", () => {
  const channel = {
    slug: "x",
    name: "X Channel",
    url: "https://youtube.com/@x",
  };

  async function withTmpPath(fn: (path: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "channel-json-test-"));
    try {
      await fn(join(dir, "channel.json"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("文件不存在时写入，含当前时间的 firstSeenAt", async () => {
    await withTmpPath(async (path) => {
      const now = new Date("2026-04-19T00:00:00.000Z");
      await ensureChannelJson(path, channel, now);
      const payload = await Bun.file(path).json();
      expect(payload).toEqual({
        slug: "x",
        name: "X Channel",
        url: "https://youtube.com/@x",
        firstSeenAt: "2026-04-19T00:00:00.000Z",
      });
    });
  });

  it("文件已存在时保持 firstSeenAt 不动，也不改写文件字节", async () => {
    await withTmpPath(async (path) => {
      const firstTime = new Date("2020-01-01T00:00:00.000Z");
      await ensureChannelJson(path, channel, firstTime);
      const before = await Bun.file(path).text();

      const laterTime = new Date("2026-04-19T00:00:00.000Z");
      await ensureChannelJson(path, channel, laterTime);
      const after = await Bun.file(path).text();

      expect(after).toBe(before);
      expect((await Bun.file(path).json()).firstSeenAt).toBe("2020-01-01T00:00:00.000Z");
    });
  });
});
