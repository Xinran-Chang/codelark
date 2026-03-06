import "dotenv/config";
import logger from "./logger";

export interface AppConfig {
  feishu: {
    appId: string;
    appSecret: string;
  };
  port: number;
  opencode: {
    path: string;
    port: number;
    cwd: string;
    startupTimeoutMs: number;
  };
  nodeEnv: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    logger.fatal(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const config: AppConfig = {
  feishu: {
    appId: requireEnv("FEISHU_APP_ID"),
    appSecret: requireEnv("FEISHU_APP_SECRET"),
  },
  port: Number(process.env.PORT) || 3000,
  opencode: {
    path: process.env.OPENCODE_PATH || "opencode",
    port: Number(process.env.OPENCODE_PORT) || 4096,
    cwd: process.env.OPENCODE_CWD || "./output",
    startupTimeoutMs: Number(process.env.OPENCODE_STARTUP_TIMEOUT) || 30_000,
  },
  nodeEnv: process.env.NODE_ENV || "development",
};

export default config;
