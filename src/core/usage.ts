export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  [key: string]: unknown;
}

/** Returns `usage` when it contains a numeric total_tokens. */
export function extractUsage(value: unknown): Usage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = (value as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return undefined;

  const record = usage as Usage;
  if (typeof record.total_tokens !== "number" || !Number.isFinite(record.total_tokens)) {
    return undefined;
  }
  return record;
}

export interface StreamAccumulator {
  /** Visible output text, used to estimate usage when DeepSeek omits it. */
  text: string;
  usage?: Usage;
}

/**
 * Accumulate output text and usage from a chat completion chunk.
 * Handles content, reasoning content and tool-call arguments.
 */
export function accumulateStreamChunk(chunk: unknown, acc: StreamAccumulator): void {
  if (typeof chunk !== "object" || chunk === null) return;

  const usage = extractUsage(chunk);
  if (usage) acc.usage = usage;

  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return;

  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;

    const record = choice as Record<string, any>;
    const delta = record.delta ?? record.message ?? record;

    if (typeof delta.content === "string") acc.text += delta.content;
    if (typeof delta.reasoning_content === "string") acc.text += delta.reasoning_content;

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const args = call?.function?.arguments;
        if (typeof args === "string") acc.text += args;
      }
    }

    if (typeof record.text === "string") acc.text += record.text;
  }
}
