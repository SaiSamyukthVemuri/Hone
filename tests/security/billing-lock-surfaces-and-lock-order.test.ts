import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// (1) EVERY app path that can create an appointment or a session can be refused by the billing trigger
// (0387), which raises an internal code. This pins where those paths are, and what each may do with the
// refusal, so a new caller cannot slip the raw error to someone who is not the owner.
// (2) LOCK ORDER: the front-desk seat lock is always the LAST lock taken. Nothing may take it and then the
// billing row, or a receptionist invitation racing a plan change deadlocks.

// RPCs (transitively) reachable from the app that insert into appointments or sessions. Derived from the
// migrations when this was written; the discovery test below fails when a new caller appears.
const INSERT_CAPABLE_RPCS = [
  "create_public_appointment", "create_public_appointment_for_new_client", "create_waitlist_public_appointment",
  "redeem_and_book_waitlist_invitation", "create_internal_appointment_v2", "reschedule_appointment_v2",
  "receptionist_book_opening", "start_session",
];
const PUBLIC_OR_CLIENT_FACING = [
  "app/book/[slug]/actions.ts", "app/portal/rebook-actions.ts", "app/reschedule/[token]/actions.ts",
  "lib/waitlist/over-invite-port.ts", "lib/portal/queries.ts", "lib/booking/waitlist-atomic-result.ts",
];
const STAFF = [
  "app/(app)/calendar/actions.ts", "app/(desk)/desk/booking-actions.ts", "app/(app)/clients/[id]/sessions/new/actions.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("every caller of an appointment or session insert is known and keeps the refusal private", () => {
  const files = [...walk("app"), ...walk("lib")];
  const callers = new Map<string, string[]>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const rpc of INSERT_CAPABLE_RPCS) {
      if (new RegExp(`rpc\\(\\s*["']${rpc}["']`).test(src)) callers.set(f, [...(callers.get(f) ?? []), rpc]);
    }
  }

  it("finds no caller outside the audited set", () => {
    const known = new Set([...PUBLIC_OR_CLIENT_FACING, ...STAFF, "lib/booking/slots.ts", "lib/export/resource-registry.ts"]);
    const strangers = [...callers.keys()].filter((f) => !known.has(f));
    expect(strangers, "a new caller of an insert-capable command must be reviewed for the billing refusal").toEqual([]);
    expect(callers.size).toBeGreaterThan(3);
  });

  it("never lets a client-facing path read the lock code or return a raw database message", () => {
    for (const file of PUBLIC_OR_CLIENT_FACING) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/subscription_(payment_required|canceled)|lock-message|BILLING_LOCK/);
      expect(src, file).not.toMatch(/error:\s*[A-Za-z_.?]*(rpcErr|error|err|bookErr|booked\.error)\??\.message/);
      expect(src, file).not.toMatch(/(rpcErr|bookErr|error)\??\.(message|details|hint)\s*[,)}]/);
    }
  });

  it("never returns a raw database message from a staff path either; the lock gets the neutral text", () => {
    for (const file of STAFF) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/error:\s*[A-Za-z_.?]*(rpcErr|error|err|bookErr|booked\.error)\??\.message/);
    }
    for (const file of ["app/(app)/calendar/actions.ts", "app/(desk)/desk/booking-actions.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).toContain("isBillingLockError(");
      expect(src, file).toContain("BILLING_LOCK_STAFF_MESSAGE");
    }
    const mapper = readFileSync("lib/sessions/session-command-errors.ts", "utf8");
    expect(mapper).toContain("BILLING_LOCK_STAFF_MESSAGE");
    expect(mapper).toContain("subscription_canceled");
  });
});

describe("lock order: the seat lock is last, never followed by the billing row", () => {
  const SEAT_LOCK = /hone:front-desk-seats|front_desk_seat_claim\s*\(/i;
  const BILLING_WRITE = /(update|insert\s+into|delete\s+from)\s+public\.hone_signup_attempts|from\s+public\.hone_signup_attempts[^;]*for\s+(update|share)/i;
  const migrations = readdirSync("supabase/migrations").filter((f) => /^038[789]_/.test(f));

  it("finds the three billing migrations", () => {
    expect(migrations).toHaveLength(3);
  });

  it("no function takes the seat lock and then touches the billing row", () => {
    let withLock = 0;
    for (const file of migrations) {
      const sql = readFileSync(`supabase/migrations/${file}`, "utf8");
      const bodies = sql.split(/\ncreate (?:or replace )?function /i).slice(1);
      for (const body of bodies) {
        const at = body.search(SEAT_LOCK);
        if (at < 0) continue;
        withLock++;
        expect(body.slice(at), `${file}: ${body.slice(0, 60)}`).not.toMatch(BILLING_WRITE);
      }
    }
    expect(withLock, "the seat-sync function must be seen, or this pin is vacuous").toBeGreaterThan(0);
  });

  it("receptionist invitations never take the billing row", () => {
    const sql = readFileSync(readdirSync("supabase/migrations").filter((f) => /^0388_/.test(f)).map((f) => `supabase/migrations/${f}`)[0], "utf8");
    expect(sql).toMatch(/new\.role is distinct from 'receptionist'/);
  });
});

describe("DB suites that flip the front_desk rollout refuse a rehearsal or non-pristine stack", () => {
  const flippers = readdirSync("tests/db")
    .filter((f) => f.endsWith(".db.test.ts"))
    .filter((f) => /platform_rollouts\s+set\s+mode\s*=\s*'pilot'/.test(readFileSync(`tests/db/${f}`, "utf8")))
    // The rollout-control suite owns that table and has its own pristine/restore contract.
    .filter((f) => f !== "platform-rollout-control.db.test.ts");

  it("finds the suites that flip it", () => {
    expect(flippers.length).toBeGreaterThanOrEqual(2);
  });

  it("every one calls the guard before its first write and restores what it listed", () => {
    for (const f of flippers) {
      const src = readFileSync(`tests/db/${f}`, "utf8");
      const guard = src.indexOf("await assertMayMutateFrontDeskRollout()");
      const flip = src.search(/platform_rollouts\s+set\s+mode\s*=\s*'pilot'/);
      expect(guard, f).toBeGreaterThan(-1);
      expect(guard, f).toBeLessThan(flip);
      expect(src, f).toMatch(/delete from public\.platform_rollout_studios where rollout_key='front_desk'/);
    }
  });
});
