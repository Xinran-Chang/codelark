import {
  Client,
  WSClient,
  EventDispatcher,
  AppType,
} from "@larksuiteoapi/node-sdk";
import config from "../config";
import logger from "../logger";

const log = logger.child({ service: "feishu" });

// Feishu text message has a practical limit around 4000 chars
const MAX_MESSAGE_LENGTH = 4000;

export type FeishuMessageData = {
  message: {
    chat_id: string;
    chat_type: string;
    content: string;
    message_id: string;
    message_type: string;
    [key: string]: any;
  };
  sender: {
    sender_id: {
      open_id: string;
      [key: string]: any;
    };
    [key: string]: any;
  };
  [key: string]: any;
};

export type MessageEventHandler = (data: FeishuMessageData) => void;

export class FeishuService {
  private client: InstanceType<typeof Client>;
  private wsClient: InstanceType<typeof WSClient>;
  private connected = false;
  private botOpenId: string | null = null;

  constructor() {
    this.client = new Client({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      appType: AppType.SelfBuild,
    });

    this.wsClient = new WSClient({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
    });
  }

  /**
   * Start listening for Feishu messages via WebSocket
   */
  start(onMessage: MessageEventHandler): void {
    const eventDispatcher = new EventDispatcher({}).register({
      "im.message.receive_v1": async (data: any) => {
        log.info(
          { messageId: data?.message?.message_id },
          "Received Feishu message event",
        );
        onMessage(data as FeishuMessageData);
        return {};
      },
    });

    this.wsClient.start({ eventDispatcher });
    this.connected = true;
    log.info("Feishu WebSocket connection started");
  }

  /**
   * Convert standard Markdown to Feishu card-compatible Markdown.
   * Feishu cards only support: bold, italic, strikethrough, links,
   * lists, and inline code. Headers, code blocks, tables, and
   * horizontal rules are NOT supported.
   */
  private sanitizeMarkdown(md: string): string {
    return (
      md
        // Convert headers (# ~ ######) to bold text
        .replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, text) => {
          return `**${text.trim()}**`;
        })
        // Convert fenced code blocks (```lang ... ```) to plain text with markers
        .replace(/```[\w]*\n([\s\S]*?)```/g, (_match, code) => {
          // Indent code lines and wrap with visual markers
          const lines = code.trimEnd().split("\n");
          return (
            "📝 **Code:**\n" + lines.map((l: string) => `  ${l}`).join("\n")
          );
        })
        // Convert horizontal rules (--- / *** / ___) to a visual separator
        .replace(/^[-*_]{3,}\s*$/gm, "───────────────────")
    );
  }

  /**
   * Build the JSON structure for a Markdown message card
   */
  private buildCardContent(content: string, title?: string): string {
    return JSON.stringify({
      config: {
        wide_screen_mode: true,
      },
      header: {
        title: {
          tag: "plain_text",
          content: title || "CodeLark",
        },
        template: "purple",
      },
      elements: [
        {
          tag: "markdown",
          content: this.sanitizeMarkdown(content) || " ",
        },
      ],
    });
  }

  /**
   * Send a text message to a Feishu chat
   */
  async sendMessage(chatId: string, content: string): Promise<string> {
    const chunks = this.splitMessage(content);
    let firstMessageId = "";

    for (let i = 0; i < chunks.length; i++) {
      const text =
        chunks.length > 1
          ? `[${i + 1}/${chunks.length}]\n${chunks[i]}`
          : chunks[i];

      const result: any = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: this.buildCardContent(text),
          msg_type: "interactive",
        },
      });

      if (i === 0) {
        firstMessageId = result?.data?.message_id || "";
      }
    }

    log.info({ chatId, chunks: chunks.length }, "Message sent");
    return firstMessageId;
  }

  /**
   * Reply to a specific message (creates a thread in the chat)
   */
  async replyMessage(messageId: string, content: string): Promise<string> {
    const chunks = this.splitMessage(content);
    let firstReplyId = "";

    for (let i = 0; i < chunks.length; i++) {
      const text =
        chunks.length > 1
          ? `[${i + 1}/${chunks.length}]\n${chunks[i]}`
          : chunks[i];

      const result: any = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: this.buildCardContent(text),
          msg_type: "interactive",
        },
      });

      if (i === 0) {
        firstReplyId = result?.data?.message_id || "";
      }
    }

    log.info({ messageId, chunks: chunks.length }, "Reply sent");
    return firstReplyId;
  }

  /**
   * Update an existing message content
   */
  async updateMessage(messageId: string, content: string): Promise<void> {
    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: {
        content: this.buildCardContent(content),
      },
    });
    log.debug({ messageId }, "Message updated");
  }

  /**
   * Split a long message into chunks that fit Feishu's limit
   */
  private splitMessage(content: string): string[] {
    if (content.length <= MAX_MESSAGE_LENGTH) {
      return [content];
    }

    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }

      // Try to split at a newline near the limit
      let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
      if (splitAt < MAX_MESSAGE_LENGTH * 0.5) {
        // No good newline found, split at a space
        splitAt = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
      }
      if (splitAt < MAX_MESSAGE_LENGTH * 0.5) {
        // No good split point, force split
        splitAt = MAX_MESSAGE_LENGTH;
      }

      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt).trimStart();
    }

    return chunks;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
