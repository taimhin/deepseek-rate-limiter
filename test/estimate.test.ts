import { describe, expect, it } from "vitest";
import {
  estimateChatRequestTokens,
  estimateChatTokens,
  estimateCompletionTextTokens,
  estimateTextTokens,
} from "../src/core/estimate.js";

describe("token estimation", () => {
  it("estimates ASCII, CJK and mixed text", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("hello")).toBe(2);
    expect(estimateTextTokens("你好世界")).toBe(4);
    expect(estimateTextTokens("hello你好")).toBe(4);
  });

  it("estimates a chat request with message overhead", () => {
    const estimate = estimateChatTokens(
      { messages: [{ role: "user", content: "hi" }] },
      { expectedCompletionTokens: 512 },
    );

    expect(estimate.prompt).toBe(9);
    expect(estimate.completion).toBe(512);
    expect(estimate.total).toBe(521);
  });

  it("reserves no more than max_tokens for the completion", () => {
    const small = estimateChatTokens(
      { messages: [{ role: "user", content: "hi" }], max_tokens: 50 },
      { expectedCompletionTokens: 512 },
    );
    expect(small.completion).toBe(50);

    const large = estimateChatTokens(
      { messages: [{ role: "user", content: "hi" }], max_tokens: 8000 },
      { expectedCompletionTokens: 512 },
    );
    expect(large.completion).toBe(512);
  });

  it("counts tools and legacy prompts", () => {
    const withTools = estimateChatTokens({
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ],
    });
    const withoutTools = estimateChatTokens({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(withTools.prompt).toBeGreaterThan(withoutTools.prompt);

    const legacy = estimateChatTokens({ prompt: "hello" });
    expect(legacy.prompt).toBe(6);
    expect(legacy.total).toBe(legacy.prompt + legacy.completion);
  });

  it("exposes a total-only helper", () => {
    expect(
      estimateChatRequestTokens({ messages: [{ role: "user", content: "hi" }] }),
    ).toBe(521);
  });

  it("estimates completion text from a non-streaming response", () => {
    expect(
      estimateCompletionTextTokens({
        choices: [{ message: { content: "hello world" } }],
      }),
    ).toBe(3);
  });
});
