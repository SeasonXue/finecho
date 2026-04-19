import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVtt } from "./parse-vtt.ts";

const tmpDirs: string[] = [];

async function writeTmp(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "parse-vtt-"));
  tmpDirs.push(dir);
  const p = join(dir, name);
  await writeFile(p, content, "utf8");
  return p;
}

afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

describe("parseVtt", () => {
  it("解析基础 vtt：时间戳 + 文本", async () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.500
你好世界

00:00:04.000 --> 00:00:06.000
第二段
`;
    const path = await writeTmp("a.vtt", vtt);
    const segs = await parseVtt(path);
    expect(segs).toEqual([
      { start: 1, end: 3.5, text: "你好世界" },
      { start: 4, end: 6, text: "第二段" },
    ]);
  });

  it("支持 mm:ss.fff 短时间格式", async () => {
    const vtt = `WEBVTT

01:30.000 --> 01:32.000
短格式
`;
    const path = await writeTmp("b.vtt", vtt);
    const segs = await parseVtt(path);
    expect(segs).toEqual([{ start: 90, end: 92, text: "短格式" }]);
  });

  it("剥离行内时间戳标签 <00:00:01.000>", async () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:05.000
你<00:00:02.000>好<00:00:03.000>世界
`;
    const path = await writeTmp("c.vtt", vtt);
    const segs = await parseVtt(path);
    expect(segs[0]!.text).toBe("你好世界");
  });

  it("剥离 <c> / <v> / <b> / <i> 标签", async () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
<v Speaker><c.colorE5E5E5>有色彩</c></v> <b>粗</b>体 <i>斜</i>体
`;
    const path = await writeTmp("d.vtt", vtt);
    const segs = await parseVtt(path);
    expect(segs[0]!.text).toBe("有色彩 粗体 斜体");
  });

  it("解码常见 HTML 实体", async () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
A&amp;B &lt;C&gt; &quot;D&quot; &#39;E&#39;&nbsp;F
`;
    const path = await writeTmp("e.vtt", vtt);
    const segs = await parseVtt(path);
    expect(segs[0]!.text).toBe("A&B <C> \"D\" 'E' F");
  });

  it("跳过 cue identifier 行", async () => {
    const vtt = `WEBVTT

cue-1
00:00:01.000 --> 00:00:02.000
内容一

cue-2
00:00:03.000 --> 00:00:04.000
内容二
`;
    const path = await writeTmp("f.vtt", vtt);
    const segs = await parseVtt(path);
    expect(segs.map((s) => s.text)).toEqual(["内容一", "内容二"]);
  });

  it("空文本 cue 不会出现在结果中", async () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000


00:00:03.000 --> 00:00:04.000
有内容
`;
    const path = await writeTmp("g.vtt", vtt);
    const segs = await parseVtt(path);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe("有内容");
  });

  it("没有 cue 时返回空数组", async () => {
    const path = await writeTmp("h.vtt", "WEBVTT\n\n");
    expect(await parseVtt(path)).toEqual([]);
  });

  it("CRLF 行结尾也能解析", async () => {
    const vtt = "WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\n你好\r\n";
    const path = await writeTmp("i.vtt", vtt);
    const segs = await parseVtt(path);
    expect(segs).toEqual([{ start: 1, end: 2, text: "你好" }]);
  });
});
