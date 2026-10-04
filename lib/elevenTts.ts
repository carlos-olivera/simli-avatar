/**
 * Browser-side client for the ElevenLabs multi-context TTS WebSocket.
 * Auth uses a single-use token minted by our server, so the API key never reaches the browser.
 * Each assistant response gets its own context; barge-in closes the active context and drops its audio.
 */
export class ElevenTTS {
  private ws: WebSocket | null = null;
  private chain: Promise<void> = Promise.resolve();
  private ctx: string | null = null;
  private ctxCounter = 0;
  private buffer = "";
  private carry: number | null = null;
  private closed = false;
  public onFirstAudio: ((ctx: string) => void) | null = null;
  private firstAudioSeen = new Set<string>();

  constructor(
    private nextUrl: string | null,
    private fetchUrl: () => Promise<string>,
    private onAudio: (pcm16k: Uint8Array) => void
  ) {}

  private connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return (async () => {
      const url = this.nextUrl ?? (await this.fetchUrl());
      this.nextUrl = null; // single-use: a reconnect needs a fresh token
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url);
        this.ws = ws;
        ws.onopen = () => resolve();
        ws.onerror = (e) => reject(e);
        ws.onmessage = (m) => this.handleMessage(m);
        ws.onclose = (e) => {
          console.log("ElevenLabs WS closed", e.code, e.reason);
          if (this.ws === ws) this.ws = null;
        };
      });
    })();
  }

  private send(msg: Record<string, unknown>) {
    if (this.closed) return;
    this.chain = this.chain
      .then(() => this.connect())
      .then(() => this.ws?.send(JSON.stringify(msg)))
      .catch((err) => console.error("ElevenLabs send failed", err));
  }

  /** Open the connection early so the first sentence doesn't pay the handshake. */
  warmUp() {
    this.chain = this.chain.then(() => this.connect()).catch((err) => console.error("ElevenLabs connect failed", err));
  }

  private handleMessage(m: MessageEvent) {
    let data: any;
    try {
      data = JSON.parse(m.data);
    } catch {
      return;
    }
    const ctx = data.contextId ?? data.context_id;
    if (data.error || data.message) console.warn("ElevenLabs:", data.error || data.message);
    if (!data.audio || !ctx || ctx !== this.ctx) return; // stale (interrupted) context -> drop
    if (!this.firstAudioSeen.has(ctx)) {
      this.firstAudioSeen.add(ctx);
      this.onFirstAudio?.(ctx);
    }
    const bin = atob(data.audio);
    let bytes = new Uint8Array(bin.length + (this.carry !== null ? 1 : 0));
    let o = 0;
    if (this.carry !== null) bytes[o++] = this.carry;
    for (let i = 0; i < bin.length; i++) bytes[o++] = bin.charCodeAt(i);
    this.carry = null;
    if (bytes.length % 2 === 1) {
      this.carry = bytes[bytes.length - 1];
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    if (bytes.length) this.onAudio(bytes);
  }

  /** Start a new assistant turn. */
  begin(): string {
    if (this.ctx) this.send({ context_id: this.ctx, close_context: true });
    this.ctx = `r${++this.ctxCounter}`;
    this.buffer = "";
    this.carry = null;
    return this.ctx;
  }

  /** Feed streamed LLM text; flushes at sentence (or long clause) boundaries for low latency. */
  push(delta: string) {
    if (!this.ctx) return;
    this.buffer += delta.replace(/[*_#`~]/g, "");
    const sentence = this.buffer.match(/^[\s\S]*?[.!?…](?=\s)/);
    let cut = sentence ? sentence[0].length : -1;
    if (cut < 0 && this.buffer.length > 80) {
      const comma = Math.max(this.buffer.lastIndexOf(", "), this.buffer.lastIndexOf("; "), this.buffer.lastIndexOf(": "));
      if (comma > 20) cut = comma + 1;
    }
    if (cut > 0) {
      const chunk = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (chunk) this.send({ context_id: this.ctx, text: chunk + " ", flush: true });
      if (this.buffer.length) this.push("");
    }
  }

  /** End of the assistant turn: speak whatever is left. */
  end() {
    if (!this.ctx) return;
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest) this.send({ context_id: this.ctx, text: rest + " ", flush: true });
  }

  /** Barge-in: stop generating and drop any audio still in flight for the current turn. */
  interrupt() {
    if (this.ctx) this.send({ context_id: this.ctx, close_context: true });
    this.ctx = null;
    this.buffer = "";
    this.carry = null;
  }

  close() {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ close_socket: true }));
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.closed = true;
    this.ws = null;
  }
}
