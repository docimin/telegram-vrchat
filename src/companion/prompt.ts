// Terminal prompts that share one stdin reader, so typed-ahead or piped lines are never lost
// between prompts (separate readline instances each grab whatever is buffered).

export class PromptCancelled extends Error {}

let buffer = "";
let ended = false;
let attached = false;
let waiters: Array<() => void> = [];

function wakeAll(): void {
  const current = waiters;
  waiters = [];
  for (const wake of current) wake();
}

function attach(): void {
  if (attached) return;
  attached = true;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    wakeAll();
  });
  process.stdin.on("end", () => {
    ended = true;
    wakeAll();
  });
}

function moreInput(): Promise<void> {
  process.stdin.resume();
  return new Promise((resolve) => waiters.push(resolve));
}

export async function ask(question: string): Promise<string> {
  attach();
  process.stdout.write(question);
  try {
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (match) {
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        return line.trim();
      }
      if (ended) {
        if (buffer) {
          const line = buffer;
          buffer = "";
          return line.trim();
        }
        process.stdout.write("\n");
        throw new PromptCancelled("No more input");
      }
      await moreInput();
    }
  } finally {
    process.stdin.pause();
  }
}

// Read a line without echoing it (for passwords). Falls back to a visible prompt without a TTY.
export async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(question);
  attach();
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  try {
    let value = "";
    for (;;) {
      const chars = Array.from(buffer);
      buffer = "";
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === "\r" || ch === "\n") {
          buffer = chars.slice(chars[i + 1] === "\n" && ch === "\r" ? i + 2 : i + 1).join("");
          process.stdout.write("\n");
          return value;
        }
        if (ch === "\u0003") {
          process.stdout.write("\n");
          throw new PromptCancelled("Cancelled");
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch !== undefined) value += ch;
      }
      if (ended) throw new PromptCancelled("No more input");
      await moreInput();
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
