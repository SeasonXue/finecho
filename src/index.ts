import { runFetch } from "./cli/fetch.ts";
import { runRebuild } from "./cli/rebuild.ts";
import { runStats } from "./cli/stats.ts";
import { runClone, runCloneBuildIndex } from "./cli/clone.ts";
import * as log from "./lib/logger.ts";

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "fetch", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return { command, flags };
}

function usage(): void {
  log.info("usage:");
  log.info("  bun run src/index.ts fetch [--limit N] [--force] [--channel slug] [--concurrency N]");
  log.info("  bun run src/index.ts rebuild [--channel slug]");
  log.info("  bun run src/index.ts stats [--channel slug]");
  log.info("  bun run src/index.ts clone [--once \"问题\"] [--channel slug] [--model id]");
  log.info("  bun run src/index.ts clone:build-index [--force] [--channel slug]");
}

async function main() {
  const { command, flags } = parseArgs(Bun.argv.slice(2));
  const channelSlug = typeof flags.channel === "string" ? flags.channel : undefined;

  switch (command) {
    case "fetch": {
      const limit =
        typeof flags.limit === "string" && /^\d+$/.test(flags.limit) ? Number(flags.limit) : undefined;
      const concurrency =
        typeof flags.concurrency === "string" && /^\d+$/.test(flags.concurrency)
          ? Number(flags.concurrency)
          : undefined;
      await runFetch({ limit, force: Boolean(flags.force), channelSlug, concurrency });
      break;
    }
    case "rebuild":
      await runRebuild({ channelSlug });
      break;
    case "stats":
      await runStats({ channelSlug });
      break;
    case "clone": {
      const once = typeof flags.once === "string" ? flags.once : undefined;
      const model = typeof flags.model === "string" ? flags.model : undefined;
      await runClone({ channelSlug, once, model });
      break;
    }
    case "clone:build-index":
      await runCloneBuildIndex({ channelSlug, force: Boolean(flags.force) });
      break;
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      log.error(`unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
