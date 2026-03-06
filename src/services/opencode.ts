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
        { timeout: 120_000 },
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

  // ─── Status & Lifecycle ────────────────────────────────────────────

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
