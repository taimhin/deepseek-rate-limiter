import type { LimiterSnapshot } from "../core/limiter.js";

export interface MetricsSnapshot {
  startedAt: number;
  uptimeSeconds: number;
  requestsTotal: number;
  requestsSucceeded: number;
  requestsFailed: number;
  rateLimited: number;
  promptTokens: number;
  completionTokens: number;
  activeStreams: number;
}

/** Process-level counters for the HTTP proxy. */
export class Metrics {
  readonly startedAt = Date.now();

  requestsTotal = 0;
  requestsSucceeded = 0;
  requestsFailed = 0;
  rateLimited = 0;
  promptTokens = 0;
  completionTokens = 0;
  activeStreams = 0;

  recordRequest(): void {
    this.requestsTotal += 1;
  }

  recordSuccess(promptTokens = 0, completionTokens = 0): void {
    this.requestsSucceeded += 1;
    this.promptTokens += Math.max(0, promptTokens);
    this.completionTokens += Math.max(0, completionTokens);
  }

  recordFailure(status?: number): void {
    this.requestsFailed += 1;
    if (status === 429) this.rateLimited += 1;
  }

  snapshot(now = Date.now()): MetricsSnapshot {
    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.max(0, Math.round((now - this.startedAt) / 1000)),
      requestsTotal: this.requestsTotal,
      requestsSucceeded: this.requestsSucceeded,
      requestsFailed: this.requestsFailed,
      rateLimited: this.rateLimited,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      activeStreams: this.activeStreams,
    };
  }
}

/** Render Prometheus text exposition format (version 0.0.4). */
export function renderPrometheus(
  limiter: LimiterSnapshot,
  metrics: MetricsSnapshot,
): string {
  const lines: string[] = [];
  const add = (name: string, help: string, type: "counter" | "gauge", value: number): void => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    lines.push(`${name} ${value}`);
  };

  add(
    "deepseek_proxy_requests_total",
    "Total inference requests received by the proxy.",
    "counter",
    metrics.requestsTotal,
  );
  add(
    "deepseek_proxy_requests_succeeded_total",
    "Inference requests completed successfully.",
    "counter",
    metrics.requestsSucceeded,
  );
  add(
    "deepseek_proxy_requests_failed_total",
    "Inference requests that failed or were rejected.",
    "counter",
    metrics.requestsFailed,
  );
  add(
    "deepseek_proxy_rate_limited_total",
    "Requests rejected with HTTP 429.",
    "counter",
    metrics.rateLimited,
  );
  add(
    "deepseek_proxy_tokens_prompt_total",
    "Prompt tokens reported by DeepSeek.",
    "counter",
    metrics.promptTokens,
  );
  add(
    "deepseek_proxy_tokens_completion_total",
    "Completion tokens reported by DeepSeek.",
    "counter",
    metrics.completionTokens,
  );
  add(
    "deepseek_limiter_active_requests",
    "Requests currently holding a limiter lease.",
    "gauge",
    limiter.usage.active,
  );
  add(
    "deepseek_limiter_queued_requests",
    "Requests waiting for rate limit capacity.",
    "gauge",
    limiter.usage.queued,
  );
  add(
    "deepseek_limiter_rpm_tokens",
    "Available request budget (RPM bucket).",
    "gauge",
    limiter.usage.rpmTokens,
  );
  add(
    "deepseek_limiter_tpm_tokens",
    "Available token budget (TPM bucket).",
    "gauge",
    limiter.usage.tpmTokens,
  );
  add(
    "deepseek_limiter_retries_total",
    "Upstream retry attempts.",
    "counter",
    limiter.totals.retries,
  );
  add(
    "deepseek_limiter_daily_tokens_used",
    "Tokens consumed in the current quota day.",
    "gauge",
    limiter.daily.tokensUsed,
  );
  add(
    "deepseek_limiter_daily_requests_used",
    "Requests consumed in the current quota day.",
    "gauge",
    limiter.daily.requestsUsed,
  );

  return `${lines.join("\n")}\n`;
}
