import { Server } from "http";
import config from "./config";
import logger from "./logger";
import { createApp } from "./app";
import { FeishuService } from "./services/feishu";
import { OpenCodeService } from "./services/opencode";
import { MessageHandler } from "./handlers/message";

const log = logger.child({ service: "main" });

async function main(): Promise<void> {
  // Initialize services
  const feishu = new FeishuService();
  const opencode = new OpenCodeService();
  const handler = new MessageHandler(feishu, opencode);

  // Start OpenCode process (sessions are created lazily per-chat)
  await opencode.start();

  // Start Feishu WebSocket
  feishu.start(handler.handle);

  // Start HTTP server
  const app = createApp(feishu, opencode);
  const server: Server = app.listen(config.port, () => {
    log.info({ port: config.port }, "CodeLark server started");
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, "Shutdown signal received");

    server.close(() => {
      log.info("HTTP server closed");
    });

    await opencode.shutdown();

    log.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "Uncaught exception");
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    log.fatal({ reason }, "Unhandled rejection");
    process.exit(1);
  });
}

main().catch((err) => {
  log.fatal({ err }, "Failed to start");
  process.exit(1);
});
