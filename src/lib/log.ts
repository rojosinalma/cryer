// Stdout logger. Level comes from env at boot; settings.ts re-applies the `log_level` setting.

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

let current: Level = "info";

export const isLevel = (v: unknown): v is Level => typeof v === "string" && v in LEVELS;

export function setLevel(level: string) {
  if (isLevel(level)) current = level;
}

export const currentLevel = () => current;

function emit(level: Level, subsystem: string, msg: string, extra?: unknown) {
  if (LEVELS[level] < LEVELS[current]) return;
  const ts = new Date().toISOString();
  const tail = extra === undefined ? "" : " " + safe(extra);
  process.stdout.write(`${ts} ${level.toUpperCase().padEnd(5)} [${subsystem}] ${msg}${tail}\n`);
}

function safe(v: unknown): string {
  if (v instanceof Error) return `${v.message}${v.stack ? "\n" + v.stack : ""}`;
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export const logger = (subsystem: string): Logger => ({
  debug: (m, e) => emit("debug", subsystem, m, e),
  info: (m, e) => emit("info", subsystem, m, e),
  warn: (m, e) => emit("warn", subsystem, m, e),
  error: (m, e) => emit("error", subsystem, m, e),
});
