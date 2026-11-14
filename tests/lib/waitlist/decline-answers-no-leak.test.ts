import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// C7 (Insurance, 0325 pre-review): the two answers the recipient types never appear in an application log, an error, the bell, the outbox
// or analytics. Marker strings stand in for the answers; the database commands are proved in the DB suite.

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ rpc: h.rpc }) }));

import { declineWithAnswers } from "@/lib/booking/waitlist-invitation";
import { WAITLIST_OFFER_DECLINED_BODY } from "@/lib/notifications/waitlist-offer-declined";

const RAW = "a1".repeat(32);
const WHY = "WHY-MARKER-7f3c";
const BETTER = "BETTER-MARKER-9d21";
const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const spies = () => (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
let console_: ReturnType<typeof spies>;
beforeEach(() => {
  h.rpc.mockReset();
  console_ = spies();
});
afterEach(() => vi.restoreAllMocks());

const seen = () => JSON.stringify(console_.map((s) => s.mock.calls));

describe("the answers never reach a log or a returned error", () => {
  const input = { rawToken: RAW, rawCapability: RAW, whyNotWork: WHY, betterTimes: BETTER };
  it("on a database error whose body echoes the input", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: `bad ${WHY} ${BETTER}`, details: WHY } });
    const out = await declineWithAnswers(input);
    expect(JSON.stringify(out)).not.toMatch(/MARKER/);
    expect(seen()).not.toMatch(/MARKER/);
  });
  it("on a thrown error that carries the answers", async () => {
    h.rpc.mockImplementation(() => {
      throw new Error(`boom ${WHY} ${BETTER}`);
    });
    const out = await declineWithAnswers(input);
    expect(out).toEqual({ kind: "unavailable" });
    expect(seen()).not.toMatch(/MARKER/);
  });
  it("on success", async () => {
    h.rpc.mockResolvedValue({ data: [{ result: "declined", invitation_id: "i1" }], error: null });
    const out = await declineWithAnswers(input);
    expect(JSON.stringify(out)).not.toMatch(/MARKER/);
    expect(seen()).not.toMatch(/MARKER/);
  });
});

describe("the answer fields are named in exactly the places that need them", () => {
  // Every application file that touches the answer fields, and what each may do with them.
  const FILES = [
    "app/invitation/[token]/actions.ts",
    "lib/booking/waitlist-invitation.ts",
    "lib/waitlist/followups-owner.ts",
    "lib/waitlist/decline-owner-email.ts",
    "lib/waitlist/decline-responses.ts",
    "app/(app)/settings/waitlist/follow-up-actions.ts",
    "components/waitlist/decline-follow-up-section.tsx",
  ];
  const ANSWER = /whyNotWork|betterTimes|why_not_work|better_times/;
  it("no log, analytics or error-reporting call in those files mentions an answer field", () => {
    for (const f of FILES) {
      const lines = read(f).split("\n");
      lines.forEach((line, i) => {
        if (/console\.|logger\.|analytics|track\(|captureException|Sentry|posthog/i.test(line)) {
          // look at the call and the two lines after it for a multi-line argument list
          const window = lines.slice(i, i + 3).join("\n");
          expect(`${f}:${i + 1} ${ANSWER.test(window)}`).toBe(`${f}:${i + 1} false`);
        }
      });
    }
  });
  it("the outbox and bell writers never name an answer field", () => {
    for (const f of ["lib/waitlist/decline-owner-email.ts", "lib/notifications/waitlist-offer-declined.ts", "lib/email/templates/waitlist-decline-owner.ts"]) {
      expect(read(f)).not.toMatch(ANSWER);
    }
    expect(WAITLIST_OFFER_DECLINED_BODY).toBe("");
  });
  it("the owner email template carries no answer", () => {
    const tpl = read("lib/email/templates/waitlist-decline-owner.ts");
    expect(tpl).toContain("Sign in to review their response");
    expect(tpl).not.toMatch(ANSWER);
  });
});
