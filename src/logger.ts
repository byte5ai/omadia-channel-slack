import { LogLevel, type Logger } from '@slack/logger';

import type { LogLevel as OmadiaLogLevel } from '@omadia/channel-sdk';

/** Sink matching `CoreApi.log` so the Slack clients' chatter can be funnelled
 *  into the channel-scoped logger. */
export type LogSink = (
  level: OmadiaLogLevel,
  message: string,
  context?: Record<string, unknown>,
) => void;

/**
 * Build a Slack-compatible {@link Logger} (the interface both `@slack/web-api`
 * and `@slack/socket-mode` accept) that forwards only `warn`/`error` to the
 * host logger and drops `debug`/`info` (the Slack clients are very chatty at
 * those levels). Slack call shapes are variadic `(...msgs)`; we join them into
 * a single string + a `detail` context for objects.
 */
export function makeSlackLogger(emit: LogSink): Logger {
  const forward =
    (level: OmadiaLogLevel) =>
    (...args: unknown[]): void => {
      const { message, context } = normalise(args);
      emit(level, `[slack] ${message}`, context);
    };

  return {
    debug: () => {},
    info: () => {},
    warn: forward('warn'),
    error: forward('error'),
    // The host owns the level; these are no-ops so the Slack clients can call
    // them without effect.
    setLevel: () => {},
    getLevel: () => LogLevel.WARN,
    setName: () => {},
  };
}

function normalise(args: unknown[]): { message: string; context?: Record<string, unknown> } {
  if (args.length === 0) return { message: '' };
  const strings = args.filter((a): a is string => typeof a === 'string');
  const objects = args.filter((a) => typeof a === 'object' && a !== null);
  const message = strings.join(' ');
  if (objects.length > 0) {
    return { message, context: { detail: objects.map(safeJson).join(' ') } };
  }
  return { message: message || args.map(String).join(' ') };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
