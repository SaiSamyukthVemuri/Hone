import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #264. After dropping appointments.cancellation_token (migration 0091),
// NO application code may read or write the raw column. These source-grep
// pins lock that in: every link-rebuild surface mints the stateless HMAC
// token, the public token routes look up cancellation_token_hash only, and
// the Appointment type no longer carries the raw field. A regression that
// re-introduces a raw-column reference would throw at runtime against the
// post-0091 schema; this catches it at unit-test time.
//
// `\bcancellation_token\b` matches the RAW column only: it never matches
// `cancellation_token_hash` (no word boundary before `_hash`) nor the RPC
// param keys `p_current_cancellation_token` / `p_new_cancellation_token`
// (no word boundary before `cancellation`).

const REPO_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string =>
  readFileSync(path.join(REPO_ROOT, rel), "utf8");

// Strip line + block comments so doc-comments mentioning the historical
// column never trip the raw-reference check.
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

const RAW = /\bcancellation_token\b/;

const FILES_NO_RAW = [
  "app/(app)/calendar/actions.ts",
  "app/api/cron/appointment-reminders/route.ts",
  "app/book/[slug]/actions.ts",
  "app/cancel/[token]/actions.ts",
  "app/reschedule/[token]/actions.ts",
  "app/manage/[token]/actions.ts",
  "lib/sms/send-appointment.ts",
];

describe("no app code references the raw appointments.cancellation_token", () => {
  for (const rel of FILES_NO_RAW) {
    it(`${rel} has no raw cancellation_token read/write`, () => {
      expect(codeOnly(read(rel)), rel).not.toMatch(RAW);
    });
  }

  it("the Appointment type no longer declares the raw cancellation_token field", () => {
    expect(codeOnly(read("lib/types/database.ts"))).not.toMatch(
      /\n\s*cancellation_token:\s*string/,
    );
    // The canonical hash field remains.
    expect(read("lib/types/database.ts")).toMatch(
      /cancellation_token_hash:\s*string\s*\|\s*null/,
    );
  });
});

describe("public token routes still look up the canonical hash column", () => {
  it("cancel + manage hash the URL token and match cancellation_token_hash", () => {
    for (const rel of [
      "app/cancel/[token]/actions.ts",
      "app/manage/[token]/actions.ts",
    ]) {
      const src = read(rel);
      expect(src, rel).toMatch(/hashAppointmentToken\(/);
      expect(src, rel).toMatch(/cancellation_token_hash/);
    }
  });

  it("link-rebuild surfaces mint the stateless HMAC token", () => {
    expect(read("app/(app)/calendar/actions.ts")).toMatch(
      /generateCancellationToken\(/,
    );
    expect(read("app/api/cron/appointment-reminders/route.ts")).toMatch(
      /generateCancellationToken\(/,
    );
  });
});
