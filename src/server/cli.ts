#!/usr/bin/env node
import { createApp } from "./app.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { createLogger } from "./logger.js";

function main(): void {
  let config: ServerConfig;
  try {
    config = loadConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[deepseek-limiter] Configuration error: ${message}`);
    process.exit(1);
  }

  const logger = createLogger(config.logLevel);
  const { app } = createApp({ config, logger });

  const server = app.listen(config.port, config.host, () => {
    const base = `http://${config.host}:${config.port}`;
    logger.info("DeepSeek rate limiter proxy is running", {
      listen: base,
      upstream: config.deepseek.baseUrl,
      auth: config.proxyApiKey ? "proxy key required" : "open (no proxy key)",
      limits: {
        rpm: config.limiter.requestsPerMinute,
        tpm: config.limiter.tokensPerMinute,
        concurrency: config.limiter.maxConcurrency,
        dailyTokens: config.limiter.dailyTokenQuota || "disabled",
        dailyRequests: config.limiter.dailyRequestQuota || "disabled",
      },
    });
    logger.info(`OpenAI-compatible base URL: ${base}/v1`);
    logger.info(`Health: ${base}/healthz  Stats: ${base}/stats  Metrics: ${base}/metrics`);
  });

  // SSE streams can stay open for a long time.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  server.on("error", (error) => {
    logger.error("HTTP server error", error);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`Received ${signal}, shutting down...`);
    const force = setTimeout(() => {
      logger.warn("Forcing shutdown after 10s");
      process.exit(1);
    }, 10_000);
    force.unref();

    server.close((error) => {
      if (error) logger.error("Error while closing server", error);
      logger.info("Shutdown complete");
      process.exit(error ? 1 : 0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
