import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { E2E_SENTRY_EGRESS_LOG } from "./local-env";

// SENTRY-E2E-NOISE-02. Reads what the lane's server WOULD have sent to Sentry,
// as recorded by e2e/helpers/sentry-egress-guard.cjs, so a spec can assert on
// the real runtime path: the real server, the real SDKs, the real tunnel.
//
// The record file is append-only and outlives a run, so a reader takes a MARK
// (the file's length) before acting and reads only what was appended after it:
// cost stays proportional to one test's traffic however long the file grows,
// and no clock comparison between the server and the runner is involved.

export type EgressException = {
  type?: string;
  value?: string;
  mechanism?: { type?: string; handled?: boolean } | null;
};

export type EgressItem = {
  type: string;
  platform?: string;
  transaction?: string;
  message?: string;
  logentry?: string;
  exceptions?: EgressException[];
};

export type EgressRecord = {
  t: string;
  pid: number;
  kind: "envelope" | "refused" | "sink-error";
  via?: string;
  host?: string | null;
  path?: string;
  userAgent?: string | null;
  forwardedHost?: string | null;
  items?: EgressItem[];
};

export type EgressErrorEvent = { record: EgressRecord; item: EgressItem };

export type EgressMark = { offset: number };

/** The point after which a reader is interested: everything appended later. */
export function markSentryEgress(): EgressMark {
  if (!existsSync(E2E_SENTRY_EGRESS_LOG)) return { offset: 0 };
  const fd = openSync(E2E_SENTRY_EGRESS_LOG, "r");
  try {
    return { offset: fstatSync(fd).size };
  } finally {
    closeSync(fd);
  }
}

/** Every complete record appended since `mark`. */
export function readSentryEgress(mark: EgressMark): EgressRecord[] {
  if (!existsSync(E2E_SENTRY_EGRESS_LOG)) return [];
  const fd = openSync(E2E_SENTRY_EGRESS_LOG, "r");
  let text: string;
  try {
    const size = fstatSync(fd).size;
    if (size <= mark.offset) return [];
    const buffer = Buffer.alloc(size - mark.offset);
    readSync(fd, buffer, 0, buffer.length, mark.offset);
    text = buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
  // Only newline-terminated lines are complete; a line still being appended is
  // read whole on the next poll, because every poll re-reads from the mark.
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  return complete
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EgressRecord);
}

/** The error events among `records`, each with the envelope that carried it. */
export function errorEvents(records: EgressRecord[]): EgressErrorEvent[] {
  return records.flatMap((record) =>
    (record.items ?? []).filter((item) => item.type === "event").map((item) => ({ record, item })),
  );
}

/** Every message-bearing string of an event, the same fields SENTRY-NOISE-01 matches. */
export function eventTexts(item: EgressItem): string[] {
  return [item.message, item.logentry, ...(item.exceptions ?? []).map((e) => e.value)].filter(
    (t): t is string => typeof t === "string",
  );
}

/** Where globalSetup leaves the run's starting mark for globalTeardown. */
export const SENTRY_EGRESS_MARK_ENV = "HONE_E2E_SENTRY_EGRESS_MARK";

/**
 * The run-end report. A genuine error raised during a run used to surface in
 * the operational Sentry project (mixed in with production, which is the
 * problem); now the guard holds it, so the lane's own log is where it must
 * stay visible. Report-only: it never fails a run.
 */
export function sentryEgressReport(since: EgressMark): string[] {
  return formatSentryEgressReport(readSentryEgress(since));
}

export function formatSentryEgressReport(records: EgressRecord[]): string[] {
  const held = records.filter((r) => r.kind === "envelope").length;
  const refused = records.filter((r) => r.kind === "refused").length;
  const lines = [
    `[sentry egress guard] held ${held} envelope(s) bound for Sentry and refused ` +
      `${refused} raw connection(s) to it during this run.`,
  ];
  const counts = new Map<string, number>();
  for (const { item } of errorEvents(records)) {
    const text = (eventTexts(item)[0] ?? "(no message)").replace(/\s+/g, " ").slice(0, 160);
    const key = `${item.platform ?? "unknown"}: ${text}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size > 0) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    lines.push(`[sentry egress guard] ${total} error event(s) were raised during the run:`);
    for (const [key, n] of counts) lines.push(`    ${n} x ${key}`);
  }
  return lines;
}

/** Poll until `pick` finds something among the records appended since `since`. */
export async function waitForSentryEgress<T>(
  pick: (records: EgressRecord[]) => T | undefined,
  { since, timeoutMs = 20_000 }: { since: EgressMark; timeoutMs?: number },
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = pick(readSentryEgress(since));
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `no matching Sentry egress record within ${timeoutMs}ms (log: ${E2E_SENTRY_EGRESS_LOG})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
