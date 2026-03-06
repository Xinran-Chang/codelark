import Router from "koa-router";
import { FeishuService } from "../services/feishu";
import { OpenCodeService } from "../services/opencode";

export function createHealthRouter(
  feishu: FeishuService,
  opencode: OpenCodeService,
): Router {
  const router = new Router();

  router.get("/health", (ctx) => {
    const opencodeStatus = opencode.getStatus();

    const healthy = feishu.isConnected() && opencodeStatus.running;

    ctx.status = healthy ? 200 : 503;
    ctx.body = {
      status: healthy ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      services: {
        feishu: {
          connected: feishu.isConnected(),
        },
        opencode: opencodeStatus,
      },
    };
  });

  return router;
}
