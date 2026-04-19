import { spawn } from "bun";

export class YtDlpError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "YtDlpError";
  }
}

async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/** 运行 yt-dlp 并一次性返回 stdout 字符串。失败时抛 YtDlpError。 */
export async function ytDlpRun(args: string[]): Promise<string> {
  const proc = spawn({
    cmd: ["yt-dlp", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readAll(proc.stdout),
    readAll(proc.stderr),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new YtDlpError(
      `yt-dlp exited with code ${exitCode}`,
      exitCode,
      stderr,
    );
  }
  return stdout;
}

/** 流式运行 yt-dlp，每行一个 JSON（配合 --dump-json）。 */
export async function* ytDlpJsonLines(args: string[]): AsyncGenerator<unknown> {
  const proc = spawn({
    cmd: ["yt-dlp", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try {
            yield JSON.parse(line);
          } catch {
            // skip malformed line
          }
        }
        nl = buf.indexOf("\n");
      }
    }
    buf += decoder.decode();
    const tail = buf.trim();
    if (tail) {
      try {
        yield JSON.parse(tail);
      } catch {
        // skip
      }
    }
  } finally {
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await readAll(proc.stderr);
      throw new YtDlpError(
        `yt-dlp exited with code ${exitCode}`,
        exitCode,
        stderr,
      );
    }
  }
}
