import { Database } from "bun:sqlite";
import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import {
  getSegmentContext,
  getVideo,
  listVideosByDate,
  searchSegments,
  youtubeTimeUrl,
  type SearchHit,
} from "./retrieval.ts";

interface ToolCtx {
  db: Database;
}

function text(body: string) {
  return {
    content: [{ type: "text" as const, text: body }],
  };
}

function formatHit(
  hit: SearchHit,
  context: Array<{ idx: number; startSec: number; text: string }>,
): string {
  // 把上下文按顺序串起来，高亮命中那条
  const body = context
    .map((c) => (c.idx === hit.idx ? `【${c.text}】` : c.text))
    .join(" / ");
  return (
    `● ${hit.uploadDate} · 《${hit.videoTitle}》\n` +
    `  ${body}\n` +
    `  来源: ${hit.sourceUrl}`
  );
}

function makeSearchSegmentsTool(ctx: ToolCtx) {
  return tool(
    "search_segments",
    [
      "查询游庭皓历史直播中与主题相关的语录。",
      "输入一个关键词/主题 query（2~20 字），返回若干段带时间戳的直播原话 + 上下文。",
      "若用户提到时间范围（最近/本月/某年以来），用 sinceDate（YYYY-MM-DD）限制。",
      "默认返回 6 条，最多 12 条。",
    ].join(" "),
    {
      query: z
        .string()
        .min(1)
        .describe("关键词或主题，例如“油價”、“AI 基建”、“空單回補”"),
      limit: z.number().int().min(1).max(12).optional().describe("返回段落数，默认 6"),
      sinceDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("YYYY-MM-DD；只返回此日期及之后的直播。"),
    },
    async (args) => {
      try {
        const hits = searchSegments(ctx.db, {
          query: args.query,
          limit: args.limit ?? 6,
          sinceDate: args.sinceDate,
        });
        if (hits.length === 0) {
          return text(
            `未找到与「${args.query}」相关的段落${
              args.sinceDate ? `（${args.sinceDate} 之后）` : ""
            }。建议换个关键词或放宽日期。`,
          );
        }
        const body = hits
          .map((h) =>
            formatHit(
              h,
              getSegmentContext(ctx.db, {
                videoId: h.videoId,
                idx: h.idx,
                before: 1,
                after: 3,
              }),
            ),
          )
          .join("\n\n");
        return text(
          `检索关键词: ${args.query}${
            args.sinceDate ? ` (since ${args.sinceDate})` : ""
          }，命中 ${hits.length} 段：\n\n${body}`,
        );
      } catch (err) {
        return text(`search_segments 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

function makeListVideosByDateTool(ctx: ToolCtx) {
  return tool(
    "list_videos_by_date",
    [
      "列出指定日期区间内的直播（按 uploadDate 升序）。",
      "用于「最近一周游老师讲了什么」「2026 年 3 月的直播」这类问题。",
      "返回视频 id、标题、日期和 YouTube 链接，供后续 get_video 取全文。",
    ].join(" "),
    {
      start: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("起始日期 YYYY-MM-DD（闭区间）"),
      end: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("结束日期 YYYY-MM-DD（闭区间）"),
    },
    async (args) => {
      const rows = listVideosByDate(ctx.db, { start: args.start, end: args.end });
      if (rows.length === 0) {
        return text(`${args.start} ~ ${args.end} 无直播`);
      }
      const body = rows
        .map(
          (v) =>
            `● ${v.uploadDate} · ${v.title}\n  id: ${v.id} · ${Math.round(
              (v.duration ?? 0) / 60,
            )} 分钟 · ${v.url}`,
        )
        .join("\n");
      return text(`${args.start} ~ ${args.end} 共 ${rows.length} 场直播：\n\n${body}`);
    },
  );
}

function makeGetVideoTool(ctx: ToolCtx) {
  return tool(
    "get_video",
    [
      "取某一场直播的完整转录（按 videoId）。",
      "数字分身需要深挖某期直播全貌时使用。",
      "默认返回前 4000 字，如需更多通过 maxChars 参数。",
    ].join(" "),
    {
      videoId: z.string().min(1).describe("YouTube video id，例如 _CPEVxMZAe4"),
      maxChars: z
        .number()
        .int()
        .min(200)
        .max(30000)
        .optional()
        .describe("正文截断字符数，默认 4000"),
    },
    async (args) => {
      const v = getVideo(ctx.db, {
        videoId: args.videoId,
        maxChars: args.maxChars ?? 4000,
      });
      if (!v) return text(`未找到 videoId=${args.videoId}`);
      return text(
        [
          `《${v.title}》`,
          `日期: ${v.uploadDate} · 时长: ${Math.round((v.duration ?? 0) / 60)} 分钟`,
          `YouTube: ${v.url}`,
          `完整字数: ${v.charCount} · 本次返回: ${v.fullText.length} 字`,
          "",
          v.fullText,
          "",
          `（如需更多请指定 maxChars，最大 ${youtubeTimeUrl("", 0) ? "" : ""}30000）`,
        ].join("\n"),
      );
    },
  );
}

export function createCorpusMcpServer(db: Database) {
  const ctx: ToolCtx = { db };
  return createSdkMcpServer({
    name: "yutinghao-corpus",
    version: "1.0.0",
    tools: [
      makeSearchSegmentsTool(ctx),
      makeListVideosByDateTool(ctx),
      makeGetVideoTool(ctx),
    ],
  });
}

export const CORPUS_MCP_NAME = "yutinghao-corpus";
export const ALLOWED_CORPUS_TOOLS = [
  "mcp__yutinghao-corpus__search_segments",
  "mcp__yutinghao-corpus__list_videos_by_date",
  "mcp__yutinghao-corpus__get_video",
];
