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

// Any link at all. No SMS log line has a reason to carry a URL: every link an
// SMS sends (manage, intake, invitation, portal) is a bearer credential.
const LINK_RE = /\bhttps?:\/\/|\bwww\./i;
// A token-bearing path without its origin ("/manage/<token>").
const TOKEN_PATH_RE =
  /\/(?:manage|intake|cancel|reschedule|invitation|portal\/verify|waitlist)\/[A-Za-z0-9._~%-]{6,}/i;
// A key that names a phone fragment, whatever its value looks like.
const PHONE_FRAGMENT_KEY_RE =
  /"[A-Za-z_]*(?:phone|masked|last\d*|digits|suffix|tail)[A-Za-z_]*"\s*:\s*"?(\d+)/gi;

// The secret parts of a link: its last path segment and its query values,
// when they are long enough to be a token. Logged alone they still grant access.
function tokenPartsOf(secret: string): string[] {
  let url: URL;
  try {
    url = new URL(secret);
  } catch {
    return [];
  }
  const parts = [url.pathname.split("/").filter(Boolean).pop() ?? ""];
  for (const value of url.searchParams.values()) parts.push(value);
  return parts.filter((p) => p.length >= 8);
}

/**
 * The minimum-necessary rule for a messaging log line, as assertions:
 *   * no record id (#828 G-26: a UUID beside messaging context is linkable);
 *   * no phone number and no fragment of one: no digits of the destination
 *     (any run of 3+ that ends the number, or 2+ under a phone-like key), and
 *     no masked form ("+1***99" still discloses the last two digits);
 *   * no message body;
 *   * no link and no token: no URL, no token-bearing path, and none of the
 *     test's own secrets (a manage or intake URL, or its token part alone);
 *   * nothing named like a phone, body or consent field.
 */
export function expectMinimumNecessary(
  text: string,
  opts: { phones: string[]; bodies?: string[]; secrets?: string[] },
): void {
  if (UUID_RE.test(text)) throw new Error(`a record id reached the log: ${text}`);
  if (/\*\*\*/.test(text)) throw new Error(`a masked phone fragment reached the log: ${text}`);
  if (/"(?:to|from)Masked"|"(?:to|from|phone|body|Body)"\s*:/.test(text)) {
    throw new Error(`a phone/body field reached the log: ${text}`);
  }
  if (LINK_RE.test(text)) throw new Error(`a link reached the log: ${text}`);
  if (TOKEN_PATH_RE.test(text)) throw new Error(`a token-bearing path reached the log: ${text}`);
  for (const secret of opts.secrets ?? []) {
    for (const part of [secret, ...tokenPartsOf(secret)]) {
      if (part && text.includes(part)) throw new Error(`a link token reached the log: ${text}`);
    }
  }
  const runs = text.split(/\D+/).filter(Boolean);
  for (const phone of opts.phones) {
    const digits = phone.replace(/\D/g, "");
    const last7 = digits.slice(-7);
    if (runs.some((run) => run.includes(last7) || (run.length >= 3 && digits.endsWith(run)))) {
      throw new Error(`phone digits reached the log: ${text}`);
    }
    for (const m of text.matchAll(PHONE_FRAGMENT_KEY_RE)) {
      if (m[1].length >= 2 && digits.endsWith(m[1])) {
        throw new Error(`phone digits reached the log under a phone-like key: ${text}`);
      }
    }
  }
  for (const body of opts.bodies ?? []) {
    if (body && text.includes(body)) throw new Error(`the message body reached the log: ${text}`);
  }
}
