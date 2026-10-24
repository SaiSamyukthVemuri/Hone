import { vi } from "vitest";

// MSG-007. Captures everything a code path writes to the console, so a test
// can prove what a SUCCESS-path log line does NOT carry.
//
// Captures the four console methods safeLog and raw console calls both end in.
// Arguments are serialised the way a log drain sees them: strings as is,
// everything else as JSON.

export type LogCapture = {
  /** Every captured line, joined. */
  text(): string;
  /** Parsed JSON payloads of lines that are JSON objects. */
  events(): Array<Record<string, unknown>>;
};

export function captureConsole(): LogCapture {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error"] as const) {
    const spy = vi.isMockFunction(console[method])
      ? (console[method] as unknown as ReturnType<typeof vi.fn>)
      : vi.spyOn(console, method);
    spy.mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  return {
    text: () => lines.join("\n"),
    events: () =>
      lines.flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? [parsed as Record<string, unknown>]
            : [];
        } catch {
          return [];
        }
      }),
  };
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The minimum-necessary rule for a messaging log line, as assertions:
 *   * no record id (#828 G-26: a UUID beside messaging context is linkable);
 *   * no phone number and no fragment of one: no digits of the destination,
 *     and no masked form ("+1***99" still discloses the last two digits);
 *   * no message body;
 *   * nothing named like a phone, body or consent field.
 */
export function expectMinimumNecessary(
  text: string,
  opts: { phones: string[]; bodies?: string[] },
): void {
  if (UUID_RE.test(text)) throw new Error(`a record id reached the log: ${text}`);
  if (/\*\*\*/.test(text)) throw new Error(`a masked phone fragment reached the log: ${text}`);
  if (/"(?:to|from)Masked"|"(?:to|from|phone|body|Body)"\s*:/.test(text)) {
    throw new Error(`a phone/body field reached the log: ${text}`);
  }
  const runs = text.split(/\D+/).filter(Boolean);
  for (const phone of opts.phones) {
    const digits = phone.replace(/\D/g, "");
    const last7 = digits.slice(-7);
    const last4 = digits.slice(-4);
    if (runs.some((run) => run.includes(last7) || run === last4)) {
      throw new Error(`phone digits reached the log: ${text}`);
    }
  }
  for (const body of opts.bodies ?? []) {
    if (body && text.includes(body)) throw new Error(`the message body reached the log: ${text}`);
  }
}
