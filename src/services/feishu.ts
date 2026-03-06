import {
  Client,
  WSClient,
  EventDispatcher,
  AppType,
} from "@larksuiteoapi/node-sdk";
import config from "../config";
import logger from "../logger";

const log = logger.child({ service: "feishu" });

export type FeishuMessageData = {
  message: {
    chat_id: string;
    content: string;
    message_id: string;
    message_type: string;
    [key: string]: any;
  };
  [key: string]: any;
};

export type MessageEventHandler = (data: FeishuMessageData) => void;

export class FeishuService {
  private client: InstanceType<typeof Client>;
  private wsClient: InstanceType<typeof WSClient>;
  private connected = false;

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

        // Process asynchronously to avoid blocking Feishu's 3s ACK timeout
        onMessage(data as FeishuMessageData);

        return {};
      },
    });

    this.wsClient.start({ eventDispatcher });
    this.connected = true;

    log.info("Feishu WebSocket connection started");
  }

  /**
   * Send a text message to a Feishu chat
   */
  async sendMessage(chatId: string, content: string): Promise<any> {
    log.info({ chatId, contentLength: content.length }, "Sending message");

    const result = await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text: content }),
        msg_type: "text",
      },
    });

    log.info({ chatId }, "Message sent");
    return result;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
