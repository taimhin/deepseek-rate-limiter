export type LogLevel = "debug" | "info" | "warn" | "error";

const PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export function createLogger(level: LogLevel = "info"): Logger {
  const enabled = (candidate: LogLevel): boolean => PRIORITY[candidate] >= PRIORITY[level];

  const write = (candidate: LogLevel, message: string, meta?: unknown): void => {
    if (!enabled(candidate)) return;

    const suffix = meta === undefined ? "" : ` ${formatMeta(meta)}`;
    const line = `${new Date().toISOString()} ${candidate.toUpperCase().padEnd(5)} ${message}${suffix}`;

    if (candidate === "error") console.error(line);
    else if (candidate === "warn") console.warn(line);
    else console.log(line);
  };

  return {
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
  };
}

function formatMeta(meta: unknown): string {
  if (meta instanceof Error) {
    return JSON.stringify({ name: meta.name, message: meta.message, stack: meta.stack });
  }
  if (typeof meta === "string") return meta;

  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}
