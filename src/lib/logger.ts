const isTTY = process.stderr.isTTY;

export function info(msg: string): void {
  process.stderr.write(msg + "\n");
}

export function warn(msg: string): void {
  process.stderr.write(`⚠ ${msg}\n`);
}

export function error(msg: string): void {
  process.stderr.write(`✗ ${msg}\n`);
}

export function success(msg: string): void {
  process.stderr.write(`✓ ${msg}\n`);
}

let lastProgressLen = 0;
export function progress(msg: string): void {
  if (!isTTY) {
    process.stderr.write(msg + "\n");
    return;
  }
  const line = `\r${msg}`;
  const pad = Math.max(0, lastProgressLen - msg.length);
  process.stderr.write(line + " ".repeat(pad));
  lastProgressLen = msg.length;
}

export function progressEnd(): void {
  if (!isTTY) return;
  if (lastProgressLen > 0) process.stderr.write("\n");
  lastProgressLen = 0;
}
