/**
 * Streaming example with the library client.
 *
 *   DEEPSEEK_API_KEY=sk-... npx tsx examples/stream.ts
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
    requestsPerMinute: 30,
    tokensPerMinute: 30_000,
    maxConcurrency: 2,
  },
});

for await (const chunk of client.chatStream({
  model: "deepseek-reasoner",
  messages: [{ role: "user", content: "Explain token buckets in three sentences." }],
})) {
  const delta = chunk.choices?.[0]?.delta;
  if (delta?.reasoning_content) process.stdout.write(delta.reasoning_content);
  if (delta?.content) process.stdout.write(delta.content);
}

process.stdout.write("\n");
console.log("Usage:", client.limiter.snapshot().totals.tokensSettled);
