import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #164. The practitioner-notification helper is the trust
// boundary between public visitor/token flows and the practitioner
// notification center. The most important property is HARD: this
// helper never throws to the caller, even when the admin client or
// the insert itself fails. A failure must not roll back the
// already-committed booking / cancel / reschedule that called it.
//
// We pin the contract textually so a future refactor that drops
// the IIFE wrapper or removes the try/catch is caught by `npm
// test`. The behavior tests below also smoke the helper at runtime
// with the synchronous validation path (the only branch we can
// exercise without a Supabase connection).

const HELPER_PATH = path.resolve(
  __dirname,
  "../../../lib/notifications/practitioner-notifications.ts",
);
const SOURCE = readFileSync(HELPER_PATH, "utf8");

describe("helper module imports + boundary", () => {
  it('first non-comment line is `import "server-only";`', () => {
    // Strip leading comments + whitespace and look at the first
    // import. PR #155 admin-server boundary uses the same shape.
    const stripped = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    expect(stripped).toMatch(/^\s*import "server-only";/);
  });

  it("imports the admin client (service-role write path)", () => {
    expect(SOURCE).toMatch(
      /import \{ createAdminClient \} from "@\/lib\/supabase\/admin-server"/,
    );
  });

  it("does NOT import the RLS-side createClient (writes bypass RLS deliberately)", () => {
    expect(SOURCE).not.toMatch(/from "@\/lib\/supabase\/server"/);
  });
});

describe("helper enforces the never-throws contract", () => {
  it("wraps the admin insert in a void fire-and-forget IIFE", () => {
    expect(SOURCE).toMatch(/void \(async \(\) => \{/);
  });

  it("the IIFE body is wrapped in try/catch", () => {
    // The fire-and-forget block must contain a try { ... } catch (err) { ... }
    // around the createAdminClient + insert. We pin the shape; the
    // catch arm logs and fires an ops_alerts entry (also fire-and-
    // forget).
    const iife =
      SOURCE.match(
        /void \(async \(\) => \{[\s\S]*?\}\)\(\);/,
      )?.[0] ?? "";
    expect(iife).toMatch(/try \{/);
    expect(iife).toMatch(/\} catch \(err\) \{/);
  });

  it("logs to ops_alerts via the existing recordOpsAlert helper", () => {
    // Two distinct sites: the insert-failure branch and the
    // catch-all branch. Both go through fireAndForgetOpsAlert.
    expect(SOURCE).toMatch(/import\("@\/lib\/ops\/alerts"\)/);
    const opsCalls = SOURCE.match(/recordOpsAlert\(/g) ?? [];
    expect(opsCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("logs structured stderr lines for the insert-failed and threw branches", () => {
    expect(SOURCE).toMatch(/practitioner_notification_insert_failed/);
    expect(SOURCE).toMatch(/practitioner_notification_insert_threw/);
  });

  it("does NOT throw or return a Promise from the public helper signature", () => {
    // The exported function must be void-returning (not async) so
    // an `await recordPractitionerNotification(...)` is a type
    // error. The caller is expected to fire-and-forget.
    expect(SOURCE).toMatch(
      /export function recordPractitionerNotification\([^)]*\): void \{/,
    );
  });
});

describe("event_type allowlist", () => {
  it("declares ALLOWED_EVENT_TYPES with the v1 set", () => {
    expect(SOURCE).toMatch(
      /ALLOWED_EVENT_TYPES[\s\S]*?Set[\s\S]*?"new_booking"[\s\S]*?"appointment_cancelled"[\s\S]*?"appointment_rescheduled"/,
    );
  });

  it("rejects an unknown event type and logs the misuse without throwing", () => {
    // The synchronous validation guard runs before the IIFE. We
    // assert the existence of the early-return branch.
    expect(SOURCE).toMatch(
      /if \(!ALLOWED_EVENT_TYPES\.has\(input\.eventType\)\)/,
    );
    expect(SOURCE).toMatch(/practitioner_notification_invalid_event_type/);
  });
});

// ---------------------------------------------------------------------------
// Runtime smoke: import the module and call the exported function
// with an invalid event type. The function must return void and
// must not throw. We cannot exercise the admin-client branch in
// unit tests (no live DB), but we can confirm the misuse branch.
// ---------------------------------------------------------------------------

describe("runtime: invalid event type does not throw", () => {
  it("returns void synchronously and swallows the misuse", async () => {
    const mod = await import("@/lib/notifications/practitioner-notifications");
    let threw = false;
    try {
      const result = mod.recordPractitionerNotification({
        studioId: "00000000-0000-0000-0000-000000000000",
        practitionerId: null,
        // Intentionally invalid; the helper logs + returns void.
        eventType: "not_a_real_event_type" as unknown as
          | "new_booking"
          | "appointment_cancelled"
          | "appointment_rescheduled",
        title: "test",
        body: null,
        appointmentId: null,
        clientId: null,
        href: null,
      });
      expect(result).toBeUndefined();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source-grep: the three event sources (public booking, public
// cancel, public reschedule) call the helper AFTER the core
// mutation succeeds. Pin the placement so a future PR cannot move
// the call to a point where a notification failure could roll back
// the user's action.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "../../..");
function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

describe("public booking action calls the helper after appointment insert", () => {
  const ACTIONS = read("app/book/[slug]/actions.ts");

  it("imports the helper", () => {
    expect(ACTIONS).toMatch(
      /import \{ recordPractitionerNotification \} from "@\/lib\/notifications\/practitioner-notifications"/,
    );
  });

  it("calls the helper with eventType: 'new_booking'", () => {
    expect(ACTIONS).toMatch(/eventType:\s*"new_booking"/);
  });

  it("the call appears AFTER the appointment INSERT block (created.id is in scope)", () => {
    // The INSERT is `.from("appointments").insert({ ... }).select("*").single()`.
    // The helper call must appear after that block.
    const insertIdx = ACTIONS.indexOf('.from("appointments")');
    const helperIdx = ACTIONS.indexOf("recordPractitionerNotification({");
    expect(insertIdx).toBeGreaterThan(-1);
    expect(helperIdx).toBeGreaterThan(-1);
    expect(helperIdx).toBeGreaterThan(insertIdx);
  });

  it("the call is NOT awaited (fire-and-forget contract)", () => {
    // The contract is the helper returns void; awaiting it would be
    // a no-op but the call site convention is to NOT prefix with
    // `await`. Pin that with a regex match against the line.
    expect(ACTIONS).not.toMatch(/await recordPractitionerNotification\(/);
  });
});

describe("public cancel action calls the helper after the cancel RPC succeeds", () => {
  const ACTIONS = read("app/cancel/[token]/actions.ts");

  it("imports the helper", () => {
    expect(ACTIONS).toMatch(
      /import \{ recordPractitionerNotification \} from "@\/lib\/notifications\/practitioner-notifications"/,
    );
  });

  it("calls the helper with eventType: 'appointment_cancelled'", () => {
    expect(ACTIONS).toMatch(/eventType:\s*"appointment_cancelled"/);
  });

  it("the call appears AFTER the public_cancel_appointment_with_token RPC", () => {
    const rpcIdx = ACTIONS.indexOf('"public_cancel_appointment_with_token"');
    const helperIdx = ACTIONS.indexOf("recordPractitionerNotification({");
    expect(rpcIdx).toBeGreaterThan(-1);
    expect(helperIdx).toBeGreaterThan(-1);
    expect(helperIdx).toBeGreaterThan(rpcIdx);
  });

  it("the call is NOT awaited", () => {
    expect(ACTIONS).not.toMatch(/await recordPractitionerNotification\(/);
  });
});

describe("public reschedule action calls the helper after the reschedule RPC succeeds", () => {
  const ACTIONS = read("app/reschedule/[token]/actions.ts");

  it("imports the helper", () => {
    expect(ACTIONS).toMatch(
      /import \{ recordPractitionerNotification \} from "@\/lib\/notifications\/practitioner-notifications"/,
    );
  });

  it("calls the helper with eventType: 'appointment_rescheduled'", () => {
    expect(ACTIONS).toMatch(/eventType:\s*"appointment_rescheduled"/);
  });

  it("the call appears AFTER the reschedule_appointment RPC", () => {
    const rpcIdx = ACTIONS.indexOf('"reschedule_appointment"');
    const helperIdx = ACTIONS.indexOf("recordPractitionerNotification({");
    expect(rpcIdx).toBeGreaterThan(-1);
    expect(helperIdx).toBeGreaterThan(-1);
    expect(helperIdx).toBeGreaterThan(rpcIdx);
  });

  it("the call is NOT awaited", () => {
    expect(ACTIONS).not.toMatch(/await recordPractitionerNotification\(/);
  });
});

// ---------------------------------------------------------------------------
// Sensitive content gate: the body composed by the three callers
// must NOT include the cancellation token, the new reschedule
// token, a Stripe id, or a portal token. Source-grep the call site
// blocks (the recordPractitionerNotification({ ... }) literals) for
// any of those substrings.
// ---------------------------------------------------------------------------

describe("notification bodies do not include tokens or secrets", () => {
  function extractCalls(rel: string): string {
    const text = read(rel);
    const matches = text.match(
      /recordPractitionerNotification\(\{[\s\S]*?\}\);/g,
    );
    return (matches ?? []).join("\n---\n");
  }

  const bookingCall = extractCalls("app/book/[slug]/actions.ts");
  const cancelCall = extractCalls("app/cancel/[token]/actions.ts");
  const rescheduleCall = extractCalls("app/reschedule/[token]/actions.ts");

  it("public booking call body does not include tokens or Stripe ids", () => {
    expect(bookingCall).not.toMatch(
      /appointmentToken|cancellation_token|newToken|stripe_payment|client_secret/,
    );
  });

  it("public cancel call body does not include tokens or Stripe ids", () => {
    expect(cancelCall).not.toMatch(
      /rpcToken|cancellation_token|stripe_payment|client_secret/,
    );
  });

  it("public reschedule call body does not include tokens or Stripe ids", () => {
    expect(rescheduleCall).not.toMatch(
      /newToken|cancellation_token|stripe_payment|client_secret/,
    );
  });
});

// ---------------------------------------------------------------------------
// Practitioner-side calendar booking does NOT fire the helper.
// The spec is explicit that v1 only covers the three PUBLIC event
// sources; a practitioner creating an appointment from the calendar
// already knows about it and would receive a noisy duplicate.
// ---------------------------------------------------------------------------

describe("practitioner-side calendar booking does NOT call the helper", () => {
  const CALENDAR = read("app/(app)/calendar/actions.ts");
  it("no recordPractitionerNotification call in calendar/actions.ts", () => {
    expect(CALENDAR).not.toMatch(/recordPractitionerNotification\(/);
  });
});

// ---------------------------------------------------------------------------
// The /notifications page + mark-all-read action use the RLS
// client. They must NOT import the admin client.
// ---------------------------------------------------------------------------

describe("notification page + action use the authenticated RLS client", () => {
  const PAGE = read("app/(app)/notifications/page.tsx");
  const ACTIONS = read("app/(app)/notifications/actions.ts");

  it("page imports createClient from @/lib/supabase/server (RLS)", () => {
    expect(PAGE).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(PAGE).not.toMatch(/admin-server|createAdminClient/);
  });

  it("page reads scoped to the authenticated studio.id", () => {
    expect(PAGE).toMatch(/\.eq\("studio_id", studio\.id\)/);
  });

  it("page renders the documented empty-state copy", () => {
    expect(PAGE).toContain("No notifications yet.");
  });

  it("mark-all-read action uses createClient (RLS) and scopes by studio.id", () => {
    expect(ACTIONS).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(ACTIONS).not.toMatch(/admin-server|createAdminClient/);
    expect(ACTIONS).toMatch(/\.eq\("studio_id", studio\.id\)/);
    expect(ACTIONS).toMatch(/\.is\("read_at", null\)/);
  });
});
