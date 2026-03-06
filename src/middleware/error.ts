import { Context, Next } from "koa";
import logger from "../logger";

const log = logger.child({ service: "middleware" });

export async function errorHandler(ctx: Context, next: Next): Promise<void> {
  try {
    await next();
  } catch (err: any) {
    const status = err.status || err.statusCode || 500;
    const message = err.expose ? err.message : "Internal Server Error";

    log.error(
      { err: err.message, status, path: ctx.path, method: ctx.method },
      "Request error",
    );

    ctx.status = status;
    ctx.body = {
      code: status,
      msg: message,
      data: null,
    };
  }
}
