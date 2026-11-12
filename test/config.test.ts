import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

describe("loadConfig", () => {
  it("applies safe defaults", () => {
    const config = loadConfig({ DEEPSEEK_API_KEY: "sk-test" });

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.deepseek.baseUrl).toBe("https://api.deepseek.com");
    expect(config.limiter.requestsPerMinute).toBe(60);
    expect(config.limiter.tokensPerMinute).toBe(60_000);
    expect(config.limiter.maxConcurrency).toBe(8);
    expect(config.limiter.dailyTokenQuota).toBe(0);
    expect(config.forceIncludeUsage).toBe(true);
  });

  it("requires a DeepSeek API key", () => {
    expect(() => loadConfig({})).toThrow(/DEEPSEEK_API_KEY/);
  });

  it("parses overrides", () => {
    const config = loadConfig({
      DEEPSEEK_API_KEY: "sk-test",
      PORT: "9999",
      DEEPSEEK_RPM: "120",
      DEEPSEEK_TPM: "250000",
      DEEPSEEK_MAX_CONCURRENCY: "3",
      DEEPSEEK_DAILY_TOKEN_QUOTA: "5000000",
      DEEPSEEK_UTC_OFFSET_MINUTES: "480",
      PROXY_API_KEY: "client-secret",
      DEEPSEEK_FORCE_INCLUDE_USAGE: "false",
    });

    expect(config.port).toBe(9999);
    expect(config.limiter.requestsPerMinute).toBe(120);
    expect(config.limiter.tokensPerMinute).toBe(250_000);
    expect(config.limiter.maxConcurrency).toBe(3);
    expect(config.limiter.dailyTokenQuota).toBe(5_000_000);
    expect(config.limiter.utcOffsetMinutes).toBe(480);
    expect(config.proxyApiKey).toBe("client-secret");
    expect(config.forceIncludeUsage).toBe(false);
  });

  it("rejects invalid values with a helpful message", () => {
    expect(() =>
      loadConfig({ DEEPSEEK_API_KEY: "sk-test", PORT: "abc" }),
    ).toThrow(/PORT/);

    expect(() =>
      loadConfig({ DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_RPM: "0" }),
    ).toThrow(/DEEPSEEK_RPM/);

    expect(() =>
      loadConfig({ DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_FORCE_INCLUDE_USAGE: "maybe" }),
    ).toThrow(/DEEPSEEK_FORCE_INCLUDE_USAGE/);
  });
});
