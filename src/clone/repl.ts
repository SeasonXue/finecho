import { Database } from "bun:sqlite";
import { createChatSession, type ChatDependencies } from "./agent.ts";
import * as log from "../lib/logger.ts";

export interface ReplOptions {
  db: Database;
  model?: string;
}

const isTTY = process.stdout.isTTY;

function dim(s: string): string {
  return isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}

function cyan(s: string): string {
  return isTTY ? `\x1b[36m${s}\x1b[0m` : s;
}

function green(s: string): string {
  return isTTY ? `\x1b[32m${s}\x1b[0m` : s;
}

function formatToolInput(name: string, input: Record<string, unknown>): string {
  const kv = Object.entries(input)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  const bare = name.replace(/^mcp__[^_]+(__|_){1,2}/, "");
  return `${bare}(${kv})`;
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  const deps: ChatDependencies = {
    db: opts.db,
    model: opts.model,
    onToolUse: (name, input) => {
      process.stdout.write(dim(`  ⋯ ${formatToolInput(name, input)}\n`));
    },
  };
  const session = createChatSession(deps);

  log.info(`${green("●")} 游庭皓数字分身已就绪。输入问题按回车提问；Ctrl+C 退出。`);

  process.stdout.write(`${cyan("你 > ")}`);

  let buffer = "";
  process.stdin.setEncoding("utf8");

  const onData = async (chunk: string): Promise<void> => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        process.stdin.pause();
        try {
          const turn = await session.ask(line);
          process.stdout.write(`${green("游 > ")}${turn.text}\n`);
          process.stdout.write(
            dim(
              `  [${turn.toolUses.length} tool calls · $${turn.costUsd.toFixed(
                4,
              )} · ${turn.durationMs}ms]\n`,
            ),
          );
        } catch (err) {
          log.error(err instanceof Error ? err.message : String(err));
        } finally {
          process.stdout.write(`${cyan("你 > ")}`);
          process.stdin.resume();
        }
      } else {
        process.stdout.write(`${cyan("你 > ")}`);
      }
      nl = buffer.indexOf("\n");
    }
  };

  process.stdin.on("data", (c) => void onData(String(c)));

  await new Promise<void>((resolve) => {
    process.stdin.on("end", () => resolve());
    process.on("SIGINT", () => {
      process.stdout.write("\n");
      resolve();
    });
  });

  session.close();
}

export async function runOnce(opts: ReplOptions, question: string): Promise<void> {
  const { askOnce } = await import("./agent.ts");
  const deps: ChatDependencies = {
    db: opts.db,
    model: opts.model,
    onToolUse: (name, input) => {
      process.stderr.write(dim(`  ⋯ ${formatToolInput(name, input)}\n`));
    },
  };
  const result = await askOnce(deps, question);
  process.stdout.write(result.text + "\n");
  log.info(
    dim(`[cost $${result.costUsd.toFixed(4)} · ${result.durationMs}ms]`),
  );
}
