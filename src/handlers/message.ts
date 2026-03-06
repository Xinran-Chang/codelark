import { FeishuService, FeishuMessageData } from "../services/feishu";
import { OpenCodeService } from "../services/opencode";
import logger from "../logger";

const log = logger.child({ service: "handler" });

const DEDUP_WINDOW_MS = 60_000; // 1 minute

export class MessageHandler {
  private feishu: FeishuService;
  private opencode: OpenCodeService;
  private recentMessageIds = new Map<string, number>();

  constructor(feishu: FeishuService, opencode: OpenCodeService) {
    this.feishu = feishu;
    this.opencode = opencode;

    // Clean up old message IDs periodically
    setInterval(() => this.cleanupDedup(), DEDUP_WINDOW_MS);
  }

  /**
   * Handle incoming Feishu message event
   */
  handle = (data: FeishuMessageData): void => {
    // Fire-and-forget to avoid blocking Feishu ACK
    this.processMessage(data).catch((err) => {
      log.error({ err }, "Unhandled error in message processing");
    });
  };

  private async processMessage(data: FeishuMessageData): Promise<void> {
    const { message } = data;
    const messageId = message.message_id;
    const chatId = message.chat_id;

    // Deduplication: skip if we've seen this message recently
    if (this.recentMessageIds.has(messageId)) {
      log.debug({ messageId }, "Duplicate message, skipping");
      return;
    }
    this.recentMessageIds.set(messageId, Date.now());

    // Parse message content
    let text = "";
    try {
      const contentObj = JSON.parse(message.content);
      text = contentObj.text || "";
    } catch {
      text = message.content || "";
    }

    if (!text.trim()) {
      log.debug({ messageId }, "Empty message, skipping");
      return;
    }

    log.info({ messageId, text: text.substring(0, 100) }, "Processing message");

    // Forward to OpenCode (per-chat session for context preservation)
    const reply = await this.opencode.sendMessage(chatId, text);

    log.info(
      { messageId, replyLength: reply.length },
      "Received OpenCode reply",
    );

    // Send reply back to Feishu
    try {
      await this.feishu.sendMessage(chatId, reply);
      log.info({ messageId, chatId }, "Reply sent");
    } catch (err: any) {
      log.error(
        { err: err.message, messageId, chatId },
        "Failed to send reply",
      );
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
