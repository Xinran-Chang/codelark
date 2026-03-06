import { FeishuService, FeishuMessageData } from "../services/feishu";
import { OpenCodeService } from "../services/opencode";
import logger from "../logger";

const log = logger.child({ service: "handler" });

const DEDUP_WINDOW_MS = 60_000;

const HELP_TEXT = `🤖 **CodeLark** — AI Coding Assistant

**Commands:**
/help — Show this help message
/new — Reset conversation and start fresh

**Usage:**
• In group chats: @mention me with your question
• In DMs: Send messages directly

**What I can do:**
• Read and analyze code projects
• Write, refactor, and debug code
• Run commands and tests
• Answer programming questions

Powered by OpenCode.`;

export class MessageHandler {
  private feishu: FeishuService;
  private opencode: OpenCodeService;
  private recentMessageIds = new Map<string, number>();

  constructor(feishu: FeishuService, opencode: OpenCodeService) {
    this.feishu = feishu;
    this.opencode = opencode;
    setInterval(() => this.cleanupDedup(), DEDUP_WINDOW_MS);
  }

  handle = (data: FeishuMessageData): void => {
    this.processMessage(data).catch((err) => {
      log.error({ err }, "Unhandled error in message processing");
    });
  };

  private async processMessage(data: FeishuMessageData): Promise<void> {
    const { message } = data;
    const messageId = message.message_id;
    const chatId = message.chat_id;
    const chatType = message.chat_type; // "group" or "p2p"

    // Deduplication
    if (this.recentMessageIds.has(messageId)) {
      log.debug({ messageId }, "Duplicate message, skipping");
      return;
    }
    this.recentMessageIds.set(messageId, Date.now());

    // Parse text content
    let text = "";
    try {
      const contentObj = JSON.parse(message.content);
      text = contentObj.text || "";
    } catch {
      text = message.content || "";
    }

    // In group chats, only respond to @mentions
    // Feishu includes @mention as @_user_1 in text, strip it out
    if (chatType === "group") {
      if (!text.includes("@_user_1")) {
        log.debug({ messageId }, "Group message without @mention, skipping");
        return;
      }
      // Remove the @mention tag from the text
      text = text.replace(/@_user_\d+/g, "").trim();
    }

    if (!text.trim()) {
      log.debug({ messageId }, "Empty message, skipping");
      return;
    }

    // Handle slash commands
    const command = text.trim().toLowerCase();

    if (command === "/help") {
      await this.feishu.replyMessage(messageId, HELP_TEXT);
      return;
    }

    if (command === "/new") {
      this.opencode.clearSession(chatId);
      await this.feishu.replyMessage(
        messageId,
        "🔄 Session reset. Starting a fresh conversation!",
      );
      log.info({ chatId }, "Session manually reset");
      return;
    }

    log.info({ messageId, text: text.substring(0, 100) }, "Processing message");

    // Send "Thinking..." status immediately
    let thinkingMessageId: string | null = null;
    try {
      thinkingMessageId = await this.feishu.replyMessage(
        messageId,
        "🤔 Thinking...",
      );
    } catch (err: any) {
      log.warn({ err: err.message }, "Failed to send thinking status");
    }

    // Progress callback: update the card with streaming text
    const onProgress = (text: string) => {
      if (!thinkingMessageId) return;
      const display =
        text.length > 20000
          ? text.substring(0, 20000) +
            "\n\n_...truncated, full response on completion_"
          : text;
      this.feishu
        .updateMessage(thinkingMessageId, display + "\n\n⏳ _Working..._")
        .catch((err) =>
          log.debug({ err: err.message }, "Progress card update failed"),
        );
    };

    // Forward to OpenCode with streaming updates
    const reply = await this.opencode.sendMessageStreaming(
      chatId,
      text,
      onProgress,
    );

    log.info(
      { messageId, replyLength: reply.length },
      "Received OpenCode reply",
    );

    // Final delivery
    try {
      if (thinkingMessageId) {
        await this.feishu.updateMessage(thinkingMessageId, reply);
      } else {
        await this.feishu.replyMessage(messageId, reply);
      }
      log.info({ messageId, chatId }, "Reply delivered");
    } catch (err: any) {
      log.error(
        { err: err.message, messageId, chatId },
        "Failed to deliver reply",
      );
      // Last resort: try sending as a new message to the chat
      try {
        await this.feishu.sendMessage(chatId, reply);
      } catch {
        log.error({ chatId }, "Failed to deliver reply by any method");
      }
    }
  }

  private cleanupDedup(): void {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    let cleaned = 0;
    for (const [id, timestamp] of this.recentMessageIds) {
      if (timestamp < cutoff) {
        this.recentMessageIds.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      log.debug({ cleaned }, "Cleaned up dedup entries");
    }
  }
}
