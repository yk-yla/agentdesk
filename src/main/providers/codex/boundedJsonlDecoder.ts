export interface OversizedJsonlLine {
  bytes: number;
  prefix: string;
}

export class BoundedJsonlDecoder {
  private buffer = "";
  private bufferBytes = 0;
  private discarding = false;
  private oversizedBytes = 0;
  private oversizedPrefix = "";

  constructor(
    private readonly maxLineBytes: number,
    private readonly prefixCharacters: number,
    private readonly onLine: (line: string) => void,
    private readonly onOversizedLine: (line: OversizedJsonlLine) => void,
  ) {}

  push(chunk: string) {
    let remaining = chunk;
    while (remaining) {
      const newlineIndex = remaining.indexOf("\n");
      const fragment = newlineIndex >= 0 ? remaining.slice(0, newlineIndex) : remaining;
      if (this.discarding) {
        this.oversizedBytes += Buffer.byteLength(fragment, "utf8");
      } else {
        this.buffer += fragment;
        this.bufferBytes += Buffer.byteLength(fragment, "utf8");
        if (this.bufferBytes > this.maxLineBytes) {
          this.discarding = true;
          this.oversizedBytes = this.bufferBytes;
          this.oversizedPrefix = this.buffer.slice(0, this.prefixCharacters);
          this.buffer = "";
          this.bufferBytes = 0;
        }
      }

      if (newlineIndex < 0) return;
      if (this.discarding) {
        this.onOversizedLine({ bytes: this.oversizedBytes, prefix: this.oversizedPrefix.replace(/\r$/, "") });
        this.discarding = false;
        this.oversizedBytes = 0;
        this.oversizedPrefix = "";
      } else {
        this.onLine(this.buffer.replace(/\r$/, ""));
        this.buffer = "";
        this.bufferBytes = 0;
      }
      remaining = remaining.slice(newlineIndex + 1);
    }
  }
}

export function rpcResponseIdFromPrefix(prefix: string) {
  const payloadIndex = prefix.search(/"(?:result|error|method)"\s*:/);
  const header = payloadIndex >= 0 ? prefix.slice(0, payloadIndex) : prefix;
  const match = header.match(/"id"\s*:\s*(\d+)(?=\s*[,}])/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}
