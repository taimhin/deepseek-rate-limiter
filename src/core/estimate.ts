export interface TokenEstimateOptions {
  /**
   * Completion tokens to reserve when the request does not specify
   * `max_tokens` / `max_completion_tokens`. Defaults to 512.
   */
  expectedCompletionTokens?: number;
}

export interface ChatTokenEstimate {
  /** Estimated prompt (input) tokens. */
  prompt: number;
  /** Estimated completion (output) tokens reserved up front. */
  completion: number;
  /** prompt + completion, always at least 1. */
  total: number;
}

/**
 * Rough token estimate that works without the official tokenizer.
 *
 * Heuristic: CJK characters ≈ 1 token each, ASCII ≈ 4 characters per token,
 * other scripts ≈ 2 characters per token. It intentionally errs on the
 * conservative side; the limiter reconciles the estimate with the real
 * `usage.total_tokens` returned by DeepSeek.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;

  let cjk = 0;
  let ascii = 0;
  let other = 0;

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isCjk(code)) cjk += 1;
    else if (code < 128) ascii += 1;
    else other += 1;
  }

  return Math.ceil(cjk + ascii / 4 + other / 2);
}

/**
 * Estimate the token cost of a chat/completions request body.
 * Works for both chat messages and legacy `prompt` requests.
 */
export function estimateChatTokens(
  body: unknown,
  options: TokenEstimateOptions = {},
): ChatTokenEstimate {
  const expected = Math.max(0, options.expectedCompletionTokens ?? 512);
  const record = isRecord(body) ? body : {};

  let prompt = 0;

  if (Array.isArray(record.messages)) {
    prompt += 3;
    for (const message of record.messages) {
      if (!isRecord(message)) continue;
      prompt += 4;
      prompt += estimateTextTokens(typeof message.role === "string" ? message.role : "");
      prompt += estimateContentTokens(message.content);
    }
  }

  if (typeof record.prompt === "string") {
    prompt += estimateTextTokens(record.prompt) + 4;
  } else if (Array.isArray(record.prompt)) {
    prompt += estimateTextTokens(JSON.stringify(record.prompt));
  }

  if (record.tools !== undefined) {
    prompt += estimateTextTokens(safeStringify(record.tools));
  }
  if (record.response_format !== undefined) {
    prompt += estimateTextTokens(safeStringify(record.response_format));
  }

  prompt = Math.max(1, prompt);

  const maxTokens =
    typeof record.max_tokens === "number"
      ? record.max_tokens
      : typeof record.max_completion_tokens === "number"
        ? record.max_completion_tokens
        : undefined;

  const completion =
    maxTokens === undefined ? expected : Math.max(0, Math.min(maxTokens, expected));

  return {
    prompt,
    completion,
    total: Math.max(1, prompt + completion),
  };
}

/** Convenience wrapper returning only the total estimate. */
export function estimateChatRequestTokens(
  body: unknown,
  options: TokenEstimateOptions = {},
): number {
  return estimateChatTokens(body, options).total;
}

/** Best-effort extraction of assistant text from a non-streaming response. */
export function estimateCompletionTextTokens(response: unknown): number {
  if (!isRecord(response)) return 0;

  let text = "";
  if (Array.isArray(response.choices)) {
    for (const choice of response.choices) {
      if (!isRecord(choice)) continue;
      const message = isRecord(choice.message) ? choice.message : undefined;
      if (message) {
        if (typeof message.content === "string") text += message.content;
        if (typeof message.reasoning_content === "string") text += message.reasoning_content;
      }
      if (typeof choice.text === "string") text += choice.text;
    }
  }

  return estimateTextTokens(text);
}

function estimateContentTokens(content: unknown): number {
  if (typeof content === "string") return estimateTextTokens(content);
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) {
      if (isRecord(part) && typeof part.text === "string") {
        total += estimateTextTokens(part.text);
      } else {
        total += estimateTextTokens(safeStringify(part));
      }
    }
    return total;
  }
  if (content === null || content === undefined) return 0;
  return estimateTextTokens(safeStringify(content));
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x2eff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
