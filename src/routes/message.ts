import Router from "koa-router";
import { FeishuService } from "../services/feishu";

export function createMessageRouter(feishu: FeishuService): Router {
  const router = new Router({ prefix: "/api/message" });

  interface SendMessageBody {
    chatId?: string;
    content?: string;
  }

  router.post("/send", async (ctx) => {
    const { chatId, content } = ctx.request.body as SendMessageBody;

    if (!chatId || !content) {
      ctx.status = 400;
      ctx.body = {
        code: 400,
        msg: "Missing required parameters: chatId and content",
        data: null,
      };
      return;
    }

    const result = await feishu.sendMessage(chatId, content);
    ctx.body = {
      code: 0,
      msg: "success",
      data: result,
    };
  });

  return router;
}
