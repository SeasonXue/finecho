import { describe, expect, it } from "bun:test";
import type { TranscriptSegment } from "../types.ts";
import {
  dedupeRollingSegments,
  segmentsToReadableBody,
  splitSentences,
} from "./normalize.ts";

const seg = (start: number, end: number, text: string): TranscriptSegment => ({
  start,
  end,
  text,
});

describe("dedupeRollingSegments", () => {
  it("空输入返回空数组", () => {
    expect(dedupeRollingSegments([])).toEqual([]);
  });

  it("当前是上一条的扩展时，用当前替换并继承上一条 start", () => {
    const input = [
      seg(0, 1, "今天我们来"),
      seg(0.5, 2, "今天我们来聊聊"),
      seg(1, 3, "今天我们来聊聊台股"),
    ];
    const out = dedupeRollingSegments(input);
    expect(out).toEqual([{ start: 0, end: 3, text: "今天我们来聊聊台股" }]);
  });

  it("当前是上一条的前缀时，丢弃当前但延长 end", () => {
    const input = [
      seg(0, 5, "今天我们来聊聊台股"),
      seg(1, 6, "今天我们来"),
    ];
    const out = dedupeRollingSegments(input);
    expect(out).toEqual([{ start: 0, end: 6, text: "今天我们来聊聊台股" }]);
  });

  it("两段无前缀关系时全部保留", () => {
    const input = [
      seg(0, 2, "今天聊台股"),
      seg(2.1, 4, "明天聊美股"),
    ];
    const out = dedupeRollingSegments(input);
    expect(out).toHaveLength(2);
    expect(out[0]!.text).toBe("今天聊台股");
    expect(out[1]!.text).toBe("明天聊美股");
  });

  it("空白与全空段被丢弃", () => {
    const input = [
      seg(0, 1, "   "),
      seg(1, 2, ""),
      seg(2, 3, "正文"),
    ];
    const out = dedupeRollingSegments(input);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("正文");
  });

  it("前缀比较忽略空白差异", () => {
    const input = [
      seg(0, 1, "今天我们 来"),
      seg(0.5, 2, "今天我们来聊"),
    ];
    const out = dedupeRollingSegments(input);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("今天我们来聊");
    expect(out[0]!.end).toBe(2);
  });

  it("对人工字幕（无滚动）幂等", () => {
    const input = [
      seg(0, 2, "第一句完整。"),
      seg(2.1, 4, "第二句也完整。"),
      seg(4.1, 6, "第三句结束。"),
    ];
    const out = dedupeRollingSegments(input);
    expect(out).toEqual(input);
    // 二次跑不应再变化
    expect(dedupeRollingSegments(out)).toEqual(input);
  });

  it("当前等于上一条时按前缀分支替换（end 取当前）", () => {
    const input = [
      seg(0, 2, "重复"),
      seg(2.1, 5, "重复"),
    ];
    const out = dedupeRollingSegments(input);
    expect(out).toEqual([{ start: 0, end: 5, text: "重复" }]);
  });
});

describe("splitSentences", () => {
  it("空字符串返回空数组", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   ")).toEqual([]);
  });

  it("按中文标点切句并保留标点", () => {
    expect(splitSentences("第一句。第二句！第三句？")).toEqual([
      "第一句。",
      "第二句！",
      "第三句？",
    ]);
  });

  it("末尾无标点的残句也保留", () => {
    expect(splitSentences("有句号。没有句号")).toEqual(["有句号。", "没有句号"]);
  });

  it("省略号作为句末符", () => {
    expect(splitSentences("欲言又止…然后呢")).toEqual(["欲言又止…", "然后呢"]);
  });

  it("合并多余空白", () => {
    expect(splitSentences("  多  空  格  ")).toEqual(["多 空 格"]);
  });
});

describe("segmentsToReadableBody", () => {
  it("空 segments 返回空字符串", () => {
    expect(segmentsToReadableBody([])).toBe("");
  });

  it("单段无停顿时不切段", () => {
    const out = segmentsToReadableBody([
      seg(0, 2, "第一句"),
      seg(2.1, 4, "第二句"),
    ]);
    expect(out).toBe("第一句 第二句");
  });

  it("停顿超过阈值切新段", () => {
    const out = segmentsToReadableBody([
      seg(0, 2, "上半段"),
      seg(10, 12, "下半段"),
    ], { gapSeconds: 1.5 });
    expect(out).toBe("上半段\n\n下半段");
  });

  it("段长超过 maxParagraphChars 强制切段", () => {
    const a = "啊".repeat(20);
    const b = "啵".repeat(20);
    const out = segmentsToReadableBody([
      seg(0, 1, a),
      seg(1.1, 2, b),
    ], { gapSeconds: 5, maxParagraphChars: 25 });
    expect(out).toBe(`${a}\n\n${b}`);
  });

  it("停顿阈值与字符上限可独立配置", () => {
    const out = segmentsToReadableBody([
      seg(0, 1, "甲"),
      seg(1.1, 2, "乙"),
      seg(5, 6, "丙"),
    ], { gapSeconds: 2 });
    expect(out).toBe("甲 乙\n\n丙");
  });

  it("跳过纯空白段", () => {
    const out = segmentsToReadableBody([
      seg(0, 1, "甲"),
      seg(1.1, 2, "   "),
      seg(2.1, 3, "乙"),
    ]);
    expect(out).toBe("甲 乙");
  });
});
