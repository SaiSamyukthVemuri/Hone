import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { sendWaitlistInvitationEmail } from "@/lib/waitlist/delivery/send";
import { invitationExpiryLabel } from "@/lib/waitlist/invitation-deadline";
import type { IdempotentEmailTransport } from "@/lib/email/new-client-waitlist-send";

vi.mock("server-only", () => ({}));

// The studio-local deadline puts the studio's timezone into the invitation email. The provider's idempotency key for that email is the
// INVITATION ALONE (no payload digest), so the same key must never carry different bytes: the provider answers that with a refusal
// (`invalid_idempotent_request`), not a replay. This file pins every case where that could happen today, and names the one it relies on structure for.

const STUDIO = { id: "11111111-1111-4111-8111-111111111111", name: "Willow Electrolysis", postcare_contact_email: "hello@willow.test", owner_email: "owner@willow.test" };
const INVITATION_ID = "22222222-2222-4222-8222-222222222222";
const ISSUED = new Date("2026-03-05T12:00:00.000Z");
const EXPIRES = new Date("2026-03-08T12:00:00.000Z"); // 72 h later, across the 2026 North American spring-forward (2026-03-08 07:00Z)
const base = (timezone: string | null) => ({
  studio: { ...STUDIO, timezone },
  invitationId: INVITATION_ID,
  recipientEmail: "prospect@example.test",
  invitationUrl: "https://hone.care/invitation/RAWTOKEN",
  issuedAt: ISSUED,
  expiresAt: EXPIRES,
  now: new Date(ISSUED.getTime() + 60_000),
});

type Call = { payload: { html?: string; text?: string; subject?: string }; key?: string };
function transport(answers: ("accepted" | "throw")[]): { t: IdempotentEmailTransport; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  return {
    calls,
    t: {
      emails: {
        send: async (payload, options) => {
          calls.push({ payload: payload as Call["payload"], key: options?.idempotencyKey });
          const a = answers[Math.min(i++, answers.length - 1)];
          if (a === "throw") throw new Error("network");
          return { data: { id: "msg" }, error: null };
        },
      },
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("one delivery key always carries the same bytes", () => {
  it("the bounded retry within one invocation: two attempts, the same key and byte-identical content", async () => {
    const { t, calls } = transport(["throw", "accepted"]);
    await sendWaitlistInvitationEmail({ ...base("America/Toronto"), transport: t });
    expect(calls).toHaveLength(2);
    expect(calls[1].key).toBe(calls[0].key);
    expect(calls[1].payload).toEqual(calls[0].payload);
    expect(calls[0].payload.text).toContain("America/Toronto");
  });

  it("the key does not depend on the studio's timezone at all", async () => {
    const keys: (string | undefined)[] = [];
    for (const tz of ["America/Toronto", "America/Vancouver", "Pacific/Auckland", "UTC", null, "Not/AZone"]) {
      const { t, calls } = transport(["accepted"]);
      await sendWaitlistInvitationEmail({ ...base(tz), transport: t });
      keys.push(calls[0].key);
    }
    expect(new Set(keys).size).toBe(1);
  });

  it("DST: for one deadline and zone, the label does not change with when it is rendered, even across the clock change", () => {
    vi.useFakeTimers();
    const labels: string[] = [];
    // Before, during and after the 2026-03-08 spring-forward, and across the autumn change.
    for (const at of ["2026-03-07T12:00:00Z", "2026-03-08T06:59:59Z", "2026-03-08T07:00:01Z", "2026-03-09T12:00:00Z", "2026-11-01T12:00:00Z", "2027-01-01T00:00:00Z"]) {
      vi.setSystemTime(new Date(at));
      labels.push(invitationExpiryLabel(EXPIRES, "America/Toronto"));
    }
    expect(new Set(labels).size).toBe(1);
    expect(labels[0]).toBe("Sunday, March 8, 2026 at 8:00 AM EDT (America/Toronto)");
  });

  it("a deadline at the DST gap renders in the zone's offset at THAT instant (not the offset at render time)", () => {
    const before = invitationExpiryLabel(new Date("2026-03-08T06:30:00Z"), "America/Toronto");
    const after = invitationExpiryLabel(new Date("2026-03-08T07:30:00Z"), "America/Toronto");
    expect(before).toContain("EST");
    expect(after).toContain("EDT");
  });

  // THE ONE CASE THE PAYLOAD CANNOT PROTECT, STATED RATHER THAN HIDDEN. A SECOND invocation for the SAME invitation after the studio's timezone
  // setting changed would render different bytes under the same key. It cannot happen because nothing sends an invitation twice (below); if it ever
  // did, the provider would REFUSE (it never sends a second email), and the key stays timezone-free on purpose: moving it would send a duplicate.
  it("KNOWN LIMIT: the same invitation rendered again after a timezone change has the same key and different bytes, which is why a second invocation is forbidden", async () => {
    const a = transport(["accepted"]);
    const b = transport(["accepted"]);
    await sendWaitlistInvitationEmail({ ...base("America/Toronto"), transport: a.t });
    await sendWaitlistInvitationEmail({ ...base("America/Vancouver"), transport: b.t });
    expect(b.calls[0].key).toBe(a.calls[0].key);
    expect(b.calls[0].payload.text).not.toBe(a.calls[0].payload.text);
  });

  it("nothing sends the same invitation twice: exactly one production call site of the invitation email, and it is the adapter's one-shot delivery", () => {
    const hits = execSync(`grep -rln "sendWaitlistInvitationEmail" app lib --include='*.ts' --include='*.tsx' || true`, { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((f) => f !== "lib/waitlist/delivery/send.ts")
      .sort();
    expect(hits).toEqual(["lib/waitlist/invite-to-book-adapter.ts"]);
    const adapter = execSync(`grep -n "sendWaitlistInvitationEmail(" lib/waitlist/invite-to-book-adapter.ts`, { encoding: "utf8" }).trim().split("\n");
    expect(adapter).toHaveLength(1);
  });
});
