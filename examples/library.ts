/**
 * Use the limiter as a library (no HTTP proxy).
 *
 *   DEEPSEEK_API_KEY=sk-... npx tsx examples/library.ts
 */
import { DeepSeekClient } from "../src/index.js";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("Set DEEPSEEK_API_KEY first.");
  process.exit(1);
}

const client = new DeepSeekClient({
  apiKey,
  limiterOptions: {
    requestsPerMinute: 60,
    tokensPerMinute: 60_000,
    maxConcurrency: 4,
    dailyTokenQuota: 2_000_000,
    maxQueueSize: 100,
    queueTimeoutMs: 120_000,
  },
  maxRetries: 3,
});

const response = await client.chat({
  model: "deepseek-chat",
  messages: [
    { role: "system", content: "You are a concise assistant." },
    { role: "user", content: "用一句話介紹澳門。" },
  ],
  max_tokens: 200,
});

console.log("Answer:", response.choices?.[0]?.message?.content);
console.log("Tokens:", response.usage?.total_tokens);
console.log("Daily usage:", client.limiter.snapshot().daily);
