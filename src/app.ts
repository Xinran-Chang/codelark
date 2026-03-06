import Koa from "koa";
import bodyParser from "koa-bodyparser";
import { errorHandler } from "./middleware/error";
import { createHealthRouter } from "./routes/health";
import { createMessageRouter } from "./routes/message";
import { FeishuService } from "./services/feishu";
import { OpenCodeService } from "./services/opencode";

export function createApp(
  feishu: FeishuService,
  opencode: OpenCodeService,
): Koa {
  const app = new Koa();

  // Global error handler
  app.use(errorHandler);

  // Body parser
  app.use(bodyParser());

  // Routes
  const healthRouter = createHealthRouter(feishu, opencode);
  const messageRouter = createMessageRouter(feishu);

  app.use(healthRouter.routes());
  app.use(healthRouter.allowedMethods());
  app.use(messageRouter.routes());
  app.use(messageRouter.allowedMethods());

  return app;
}
