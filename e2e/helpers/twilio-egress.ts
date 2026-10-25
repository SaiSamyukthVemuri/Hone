import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { E2E_TWILIO_EGRESS_FAKE } from "./twilio-egress-config";
import { E2E_WEB_SERVER_ENV } from "./local-env";

// TWILIO-EGRESS-FAKE (MSG-006). Reads what the lane's server tried to send to
// Twilio, as recorded by e2e/helpers/twilio-egress-fake.cjs. The record file is
// append-only and outlives a run, so a reader takes a MARK (the file's length)
// before acting and reads only what was appended after it.

export type TwilioEgressRecord = {
  t: string;
  pid: number;
  kind: "message" | "refused";
  via: string;
  host: string | null;
  path?: string | null;
  mode: "refuse" | "ambiguous_503" | "accept";
  toLast4?: string | null;
  bodyBytes?: number;
};

export type TwilioEgressMark = { offset: number };

function logPath(): string {
  return E2E_WEB_SERVER_ENV.HONE_E2E_TWILIO_EGRESS_LOG;
}

export function markTwilioEgress(): TwilioEgressMark {
  if (!existsSync(logPath())) return { offset: 0 };
  const fd = openSync(logPath(), "r");
  try {
    return { offset: fstatSync(fd).size };
  } finally {
    closeSync(fd);
  }
}

/** Every complete record appended since `mark`. */
export function readTwilioEgress(mark: TwilioEgressMark): TwilioEgressRecord[] {
  if (!existsSync(logPath())) return [];
  const fd = openSync(logPath(), "r");
  let text: string;
  try {
    const size = fstatSync(fd).size;
    const length = Math.max(0, size - mark.offset);
    const buf = Buffer.alloc(length);
    if (length > 0) readSync(fd, buf, 0, length, mark.offset);
    text = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  return complete
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TwilioEgressRecord);
}

/**
 * globalSetup refuses a lane whose server would start without the fake: every
 * spec that reaches an SMS send would then contact the real Twilio API.
 */
export function assertTwilioEgressFakeWired(serverEnv: Record<string, string> | undefined): void {
  if (
    (serverEnv?.NODE_OPTIONS ?? "").includes(E2E_TWILIO_EGRESS_FAKE) &&
    Boolean(serverEnv?.HONE_E2E_TWILIO_EGRESS_LOG)
  ) {
    return;
  }
  throw new Error(
    [
      "",
      "=".repeat(72),
      "E2E TWILIO EGRESS FAKE NOT WIRED - refusing to run",
      "=".repeat(72),
      "",
      "  This lane's web server would start without",
      `  ${E2E_TWILIO_EGRESS_FAKE}`,
      "  so any SMS send it reached would contact the real Twilio API.",
      "  Its environment must carry withTwilioEgressFake(...) in NODE_OPTIONS and",
      "  HONE_E2E_TWILIO_EGRESS_LOG (E2E_WEB_SERVER_ENV in e2e/helpers/local-env.ts,",
      "  which every lane spreads).",
      "=".repeat(72),
      "",
    ].join("\n"),
  );
}
