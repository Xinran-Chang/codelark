import axios, { AxiosInstance } from "axios";
import { spawn, ChildProcess } from "child_process";
import net from "net";
import path from "path";
import fs from "fs";
import config from "../config";
import logger from "../logger";

const log = logger.child({ service: "opencode" });

export interface OpenCodeStatus {
  running: boolean;
  pid: number | null;
  activeSessions: number;
}

export class OpenCodeService {
  private process: ChildProcess | null = null;
  private http: AxiosInstance;
  private startLock: Promise<boolean> | null = null;
  private readonly cwd: string;

  /**
   * Maps chatId → OpenCode sessionId.
   * Each Feishu chat gets its own OpenCode session to preserve context.
   */
  private sessions = new Map<string, string>();

  /**
   * Prevents concurrent session creation for the same chatId.
   */
  private sessionLocks = new Map<string, Promise<string | null>>();

  constructor() {
    this.cwd = path.resolve(process.cwd(), config.opencode.cwd);
    this.http = axios.create({
      baseURL: `http://localhost:${config.opencode.port}`,
      timeout: 5000,
    });
  }

  // ─── Process Management ────────────────────────────────────────────

  private checkPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(1000);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, "127.0.0.1");
    });
  }

  /**
   * Ensure the OpenCode ACP process is running (with start lock)
   */
  async start(): Promise<boolean> {
    if (await this.checkPort(config.opencode.port)) {
      log.info("OpenCode service already running (port occupied)");
      return true;
    }

    // Prevent concurrent start attempts
    if (this.startLock) return this.startLock;
    this.startLock = this._start();
    const result = await this.startLock;
    this.startLock = null;
    return result;
  }

  private async _start(): Promise<boolean> {
    log.info("OpenCode service not running, starting...");

    try {
      if (!fs.existsSync(this.cwd)) {
        fs.mkdirSync(this.cwd, { recursive: true });
        log.info({ cwd: this.cwd }, "Created OpenCode working directory");
      }

      // Cannot use detached + unref — OpenCode exits immediately in detached mode
      this.process = spawn(
        config.opencode.path,
        ["acp", "--port", String(config.opencode.port), "--cwd", this.cwd],
        { stdio: ["pipe", "ignore", "pipe"] },
      );

      this.process.stderr?.on("data", (data: Buffer) => {
        log.debug({ stderr: data.toString().trim() }, "OpenCode stderr");
      });

      this.process.on("error", (err: Error) => {
        log.error({ err }, "Failed to start OpenCode process");
      });

      this.process.on("exit", (code, signal) => {
        log.warn({ code, signal }, "OpenCode process exited");
        this.process = null;
        this.sessions.clear();
        this.sessionLocks.clear();
      });

      log.info({ pid: this.process.pid }, "OpenCode ACP process started");

      const maxRetries = Math.ceil(config.opencode.startupTimeoutMs / 1000);
      for (let i = 0; i < maxRetries; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await this.checkPort(config.opencode.port)) {
          log.info("OpenCode service is ready");
          return true;
        }
        if ((i + 1) % 5 === 0) {
          log.info(
            { elapsed: i + 1, max: maxRetries },
            "Waiting for OpenCode...",
          );
        }
      }

      log.error("OpenCode startup timed out");
      return false;
    } catch (err: any) {
      log.error({ err }, "Failed to start OpenCode");
      return false;
    }
  }

  // ─── Session Management ────────────────────────────────────────────

  /**
   * Get or create an OpenCode session for a specific chat.
   * Uses per-chatId locking to prevent concurrent creation.
   */
  async getSession(chatId: string): Promise<string | null> {
    const existing = this.sessions.get(chatId);
    if (existing) return existing;

    // Per-chatId lock: if another message from the same chat is already creating a session, wait
    const pendingLock = this.sessionLocks.get(chatId);
    if (pendingLock) return pendingLock;

    const lock = this._createSession(chatId);
    this.sessionLocks.set(chatId, lock);
    const sessionId = await lock;
    this.sessionLocks.delete(chatId);
    return sessionId;
  }

  private async _createSession(chatId: string): Promise<string | null> {
    const isRunning = await this.start();
    if (!isRunning) {
      log.error("Cannot create session — OpenCode not running");
      return null;
    }

    try {
      const { data } = await this.http.post("/session", {
        title: `Chat ${chatId.substring(0, 12)}`,
      });
      const sessionId = data.id as string;
      this.sessions.set(chatId, sessionId);
      log.info({ chatId, sessionId }, "OpenCode session created for chat");
      return sessionId;
    } catch (err: any) {
      log.error(
        { err: err.message, chatId },
        "Failed to create OpenCode session",
      );
      return null;
    }
  }

  // ─── Messaging ─────────────────────────────────────────────────────

  /**
   * Send a message to OpenCode within the session bound to the given chatId
   */
  async sendMessage(chatId: string, message: string): Promise<string> {
    const sessionId = await this.getSession(chatId);
    if (!sessionId) {
      return "Error: OpenCode service unavailable";
    }

    try {
      const { data } = await this.http.post(
        `/session/${sessionId}/message`,
        { parts: [{ type: "text", text: message }] },
        { timeout: 600_000 },
      );

      let reply = "";
      if (data?.parts) {
        for (const part of data.parts) {
          if (part.type === "text" && part.text) {
            reply += part.text + "\n";
          }
        }
      }

      return reply.trim() || "OpenCode processed (no text reply)";
    } catch (err: any) {
      // If session expired or invalid, clear it and retry once
      if (err.response?.status === 404) {
        log.warn({ chatId, sessionId }, "Session not found, recreating...");
        this.sessions.delete(chatId);
        return this.sendMessage(chatId, message);
      }

      log.error(
        { err: err.message, response: err.response?.data },
        "OpenCode API error",
      );
      return `Error: ${err.message}`;
    }
  }

  /**
   * Send a message with streaming progress via SSE.
   * Calls onProgress with accumulated text (throttled to every 3s).
   * Falls back to synchronous sendMessage if SSE is unavailable.
   */
  async sendMessageStreaming(
    chatId: string,
    message: string,
    onProgress?: (text: string) => void,
  ): Promise<string> {
    const sessionId = await this.getSession(chatId);
    if (!sessionId) return "Error: OpenCode service unavailable";

    const baseUrl = `http://localhost:${config.opencode.port}`;
    const abort = new AbortController();
    const textParts = new Map<string, string>();
    let settled = false;

    const getText = () => Array.from(textParts.values()).join("\n\n").trim();

    // Throttle progress emissions to every 3 seconds
    let lastEmit = 0;
    let emitTimer: ReturnType<typeof setTimeout> | null = null;
    const THROTTLE_MS = 3000;

    const emitProgress = () => {
      if (!onProgress) return;
      const text = getText();
      if (!text) return;
      const now = Date.now();
      if (now - lastEmit >= THROTTLE_MS) {
        lastEmit = now;
        if (emitTimer) {
          clearTimeout(emitTimer);
          emitTimer = null;
        }
        onProgress(text);
      } else if (!emitTimer) {
        emitTimer = setTimeout(
          () => {
            emitTimer = null;
            lastEmit = Date.now();
            const t = getText();
            if (t) onProgress(t);
          },
          THROTTLE_MS - (now - lastEmit),
        );
      }
    };

    return new Promise<string>(async (resolve) => {
      // Hard timeout: 10 minutes
      const hardTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          if (emitTimer) clearTimeout(emitTimer);
          abort.abort();
          resolve(getText() || "Error: Request timed out");
        }
      }, 600_000);

      const finish = (text?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        if (emitTimer) clearTimeout(emitTimer);
        abort.abort();
        resolve(text || getText() || "OpenCode processed (no text reply)");
      };

      try {
        // 1. Connect to SSE event stream before sending prompt
        const sse = await fetch(`${baseUrl}/global/event`, {
          signal: abort.signal,
          headers: { Accept: "text/event-stream" },
        });

        if (!sse.ok || !sse.body) {
          clearTimeout(hardTimer);
          settled = true;
          log.warn("SSE unavailable, falling back to sync");
          resolve(await this.sendMessage(chatId, message));
          return;
        }

        // 2. Fire async prompt (returns immediately)
        try {
          await this.http.post(
            `/session/${sessionId}/prompt_async`,
            { parts: [{ type: "text", text: message }] },
            { timeout: 10_000 },
          );
        } catch (err: any) {
          clearTimeout(hardTimer);
          abort.abort();
          if (err.response?.status === 404) {
            this.sessions.delete(chatId);
            settled = true;
            resolve(
              await this.sendMessageStreaming(chatId, message, onProgress),
            );
            return;
          }
          settled = true;
          resolve(`Error: ${err.message}`);
          return;
        }

        log.info({ sessionId }, "Streaming prompt started");

        // 3. Parse SSE stream for text updates and session completion
        const reader = sse.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        try {
          while (!settled) {
            const { done, value } = await reader.read();
            if (done) break;

            buf += decoder.decode(value, { stream: true });
            const blocks = buf.split("\n\n");
            buf = blocks.pop() || "";

            for (const block of blocks) {
              if (settled) break;
              for (const line of block.split("\n")) {
                if (!line.startsWith("data:")) continue;
                try {
                  const evt = JSON.parse(line.slice(5).trim());
                  const { type, properties: p } = evt?.payload ?? {};
                  if (!p) continue;

                  if (
                    type === "message.part.delta" &&
                    p.sessionID === sessionId &&
                    p.field === "text"
                  ) {
                    // Accumulate incremental text by partID
                    const prev = textParts.get(p.partID) || "";
                    textParts.set(p.partID, prev + (p.delta || ""));
                    emitProgress();
                  } else if (
                    type === "session.idle" &&
                    p.sessionID === sessionId
                  ) {
                    finish();
                  }
                } catch {}
              }
            }
          }
        } catch (err: any) {
          if (err.name !== "AbortError") {
            log.warn({ err: err.message }, "SSE read error");
          }
        }

        // Stream ended — if not yet settled, fetch final messages
        if (!settled) {
          try {
            const { data: msgs } = await this.http.get(
              `/session/${sessionId}/message`,
              { timeout: 10_000 },
            );
            if (Array.isArray(msgs)) {
              const last = msgs
                .filter((m: any) => m.info?.role === "assistant")
                .pop();
              if (last?.parts) {
                const text = last.parts
                  .filter((p: any) => p.type === "text" && p.text)
                  .map((p: any) => p.text)
                  .join("\n\n")
                  .trim();
                if (text) {
                  finish(text);
                  return;
                }
              }
            }
          } catch {}
          finish();
        }
      } catch (err: any) {
        clearTimeout(hardTimer);
        if (err.name !== "AbortError") {
          log.error({ err: err.message }, "Streaming setup failed");
        }
        settled = true;
        try {
          resolve(await this.sendMessage(chatId, message));
        } catch {
          resolve(getText() || "Error: Streaming failed");
        }
      }
    });
  }

  // ─── Status & Lifecycle ────────────────────────────────────────────

  /**
   * Clear the session for a specific chat (used by /new command)
   */
  clearSession(chatId: string): void {
    const sessionId = this.sessions.get(chatId);
    if (sessionId) {
      this.sessions.delete(chatId);
      log.info({ chatId, sessionId }, "Session cleared");
    }
  }

  getStatus(): OpenCodeStatus {
    return {
      running: this.process !== null,
      pid: this.process?.pid ?? null,
      activeSessions: this.sessions.size,
    };
  }

  async shutdown(): Promise<void> {
    if (this.process) {
      log.info({ pid: this.process.pid }, "Stopping OpenCode process");
      this.process.kill("SIGTERM");

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            log.warn("OpenCode did not exit gracefully, force killing");
            this.process.kill("SIGKILL");
          }
          resolve();
        }, 5000);

        this.process?.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.process = null;
      this.sessions.clear();
    }
  }
}
