import { Database } from "bun:sqlite";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildSystemPrompt } from "./persona.ts";
import {
  ALLOWED_CORPUS_TOOLS,
  CORPUS_MCP_NAME,
  createCorpusMcpServer,
} from "./tools.ts";

const FALLBACK_MODEL = "claude-sonnet-4-6";
export const DEFAULT_MODEL: string =
  process.env.ANTHROPIC_MODEL && process.env.ANTHROPIC_MODEL.trim()
    ? process.env.ANTHROPIC_MODEL.trim()
    : FALLBACK_MODEL;

function requireApiKey(): void {
  if (
    !process.env.ANTHROPIC_API_KEY &&
    !process.env.CLAUDE_CODE_OAUTH_TOKEN
  ) {
    throw new Error(
      "未检测到凭证：请在 .env 里配置 CLAUDE_CODE_OAUTH_TOKEN（订阅账号，推荐）或 ANTHROPIC_API_KEY。参考 .env.example。",
    );
  }
}

export interface ChatDependencies {
  db: Database;
  model?: string;
  /** 每次工具调用前触发，用于 CLI 回显「正在检索 ...」 */
  onToolUse?: (name: string, input: Record<string, unknown>) => void;
}

function buildOptions(deps: ChatDependencies): Options {
  return {
    systemPrompt: buildSystemPrompt(),
    model: deps.model ?? DEFAULT_MODEL,
    mcpServers: {
      [CORPUS_MCP_NAME]: createCorpusMcpServer(deps.db),
    },
    allowedTools: ALLOWED_CORPUS_TOOLS,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: [], // 忽略用户/项目的 ~/.claude 配置，纯 SDK 隔离
    includePartialMessages: false,
  };
}

/**
 * 从 assistant 消息的 content 数组中提取纯文本。
 * 忽略 tool_use / thinking block。
 */
function extractAssistantText(msg: SDKMessage): string {
  if (msg.type !== "assistant") return "";
  const content = (msg.message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<{ type: string; text?: string }>) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

/** 从 assistant 消息里读出 tool_use 调用，用于 UI 提示。 */
function extractToolUses(
  msg: SDKMessage,
): Array<{ name: string; input: Record<string, unknown> }> {
  if (msg.type !== "assistant") return [];
  const content = (msg.message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ name: string; input: Record<string, unknown> }> = [];
  for (const block of content as Array<{
    type: string;
    name?: string;
    input?: Record<string, unknown>;
  }>) {
    if (block.type === "tool_use" && block.name) {
      out.push({ name: block.name, input: block.input ?? {} });
    }
  }
  return out;
}

/** 单轮问答。返回最终文本。适合脚本化调用。 */
export async function askOnce(
  deps: ChatDependencies,
  question: string,
): Promise<{ text: string; costUsd: number; durationMs: number }> {
  requireApiKey();
  const q = query({
    prompt: question,
    options: buildOptions(deps),
  });

  let finalText = "";
  let costUsd = 0;
  let durationMs = 0;
  for await (const msg of q) {
    if (msg.type === "assistant") {
      const uses = extractToolUses(msg);
      for (const u of uses) deps.onToolUse?.(u.name, u.input);
    } else if (msg.type === "result") {
      if (msg.subtype === "success") {
        finalText = msg.result;
      } else {
        throw new Error(
          `agent 失败 subtype=${msg.subtype} errors=${JSON.stringify(
            (msg as { errors?: string[] }).errors ?? [],
          )}`,
        );
      }
      costUsd = msg.total_cost_usd ?? 0;
      durationMs = msg.duration_ms ?? 0;
    }
  }
  return { text: finalText, costUsd, durationMs };
}

/**
 * 多轮会话句柄。内部用一个手动驱动的 AsyncQueue 给 SDK 喂 SDKUserMessage；
 * 每次 ask() 推一条消息进去并把该轮的所有 assistant 输出以事件形式返回。
 */
export interface ChatTurn {
  text: string;
  toolUses: Array<{ name: string; input: Record<string, unknown> }>;
  costUsd: number;
  durationMs: number;
}

class AsyncQueue<T> {
  private q: T[] = [];
  private resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;
  push(item: T) {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) r({ value: item, done: false });
    else this.q.push(item);
  }
  close() {
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: undefined as T, done: true });
    }
  }
  async *drain(): AsyncGenerator<T, void> {
    while (true) {
      if (this.q.length > 0) {
        yield this.q.shift()!;
        continue;
      }
      if (this.closed) return;
      const item: IteratorResult<T> = await new Promise((resolve) => {
        this.resolvers.push(resolve);
      });
      if (item.done) return;
      yield item.value;
    }
  }
}

export interface ChatSession {
  ask(question: string): Promise<ChatTurn>;
  close(): void;
}

export function createChatSession(deps: ChatDependencies): ChatSession {
  requireApiKey();
  const inbox = new AsyncQueue<{
    type: "user";
    message: { role: "user"; content: string };
    parent_tool_use_id: null;
    session_id: string;
  }>();

  // 初始占位 session_id；SDK 允许空字符串，它会分配自己的 id
  const sessionId = "";

  async function* prompts() {
    for await (const m of inbox.drain()) yield m;
  }

  const q = query({
    prompt: prompts(),
    options: buildOptions(deps),
  });

  // 后台迭代器；每轮通过一个 waiter Promise 把结果交回 ask()
  interface PendingTurn {
    text: string;
    toolUses: ChatTurn["toolUses"];
    resolve: (turn: ChatTurn) => void;
    reject: (err: Error) => void;
  }
  const turnRef: { current: PendingTurn | null } = { current: null };

  function handleAssistant(turn: PendingTurn, msg: SDKMessage): void {
    const t = extractAssistantText(msg);
    if (t) turn.text += t;
    const uses = extractToolUses(msg);
    for (const u of uses) {
      turn.toolUses.push(u);
      deps.onToolUse?.(u.name, u.input);
    }
  }

  function handleResult(turn: PendingTurn, msg: SDKMessage): void {
    if (msg.type !== "result") return;
    turnRef.current = null;
    if (msg.subtype === "success") {
      turn.resolve({
        text: msg.result || turn.text,
        toolUses: turn.toolUses,
        costUsd: msg.total_cost_usd ?? 0,
        durationMs: msg.duration_ms ?? 0,
      });
    } else {
      turn.reject(
        new Error(
          `agent 失败 subtype=${msg.subtype} errors=${JSON.stringify(
            (msg as { errors?: string[] }).errors ?? [],
          )}`,
        ),
      );
    }
  }

  const backgroundLoop = (async () => {
    try {
      for await (const msg of q) {
        const turn = turnRef.current;
        if (!turn) continue; // 没有正在等待的 ask 就忽略（理论上不会）
        if (msg.type === "assistant") {
          handleAssistant(turn, msg);
        } else if (msg.type === "result") {
          handleResult(turn, msg);
        }
      }
    } catch (err) {
      const turn = turnRef.current;
      if (turn) {
        turnRef.current = null;
        turn.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  })();

  return {
    async ask(question: string): Promise<ChatTurn> {
      if (turnRef.current) {
        throw new Error("上一轮问答还未完成，请等待");
      }
      const turnPromise = new Promise<ChatTurn>((resolve, reject) => {
        turnRef.current = { text: "", toolUses: [], resolve, reject };
      });
      inbox.push({
        type: "user",
        message: { role: "user", content: question },
        parent_tool_use_id: null,
        session_id: sessionId,
      });
      return turnPromise;
    },
    close() {
      inbox.close();
      backgroundLoop.catch(() => {});
    },
  };
}
