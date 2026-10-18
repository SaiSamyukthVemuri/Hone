import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  countVersion,
  isRepoMax,
  versionsAbove,
} from "./helpers/migration-state";

// 0234 — HON-47: a studio may disable CLIENT self-service cancellation and
// rescheduling. Source contract; the behaviour is proven against a real
// database in tests/db/client-self-service-controls.db.test.ts, and the client
// surfaces in tests/app/booking/client-self-service-disabled.test.ts.

const VERSION = "0234";
const FILE = path.join(
  process.cwd(),
  "supabase/migrations/0234_client_self_service_controls.sql",
);
const SQL = readFileSync(FILE, "utf8");
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
// Signatures in this migration are written across several lines, so every
// statement-level assertion below reads the whitespace-collapsed form. A
// line-anchored regex would silently miss them and pass.
const FLAT = CODE.replace(/\s+/g, " ");

const CANCEL7 =
  "public.public_cancel_appointment_with_token( text, text, text, text, boolean, boolean, text )";
const RESCHEDULE =
  "public.reschedule_appointment_v2(uuid, text, timestamptz, text, boolean, text)";

describe("0234 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this — see
    // CLAUDE.md §2. It reached this file from 0233's test (Codex P2
    // 4308819830), which is how the pin travels instead of accumulating.
    expect(isRepoMax(VERSION), "0234 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION), "something was added above 0234").toEqual(
      [],
    );
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });
});

describe("0234 is recorded as PENDING, consistently", () => {
  it("the ledger's current block lists 0234 under Pending migrations, never 'none'", () => {
    const ledger = readFileSync(
      path.join(process.cwd(), "docs/production/migration-ledger.md"),
      "utf8",
    );
    const current = ledger.slice(ledger.indexOf("## Current state"));
    const row = current.match(/\|\s*\*\*Pending migrations\*\*\s*\|([^\n]*)\|/);
    expect(row, "the current block has no Pending migrations row").toBeTruthy();
    expect(row?.[1]).toContain("`0234`");
    expect(row?.[1]).toMatch(/PENDING, NOT APPLIED/);
    expect(row?.[1]).not.toMatch(/\*\*none\*\*/);
  });
});

describe("0234 is one bounded transaction", () => {
  it("opens its own transaction and arms lock_timeout INSIDE it", () => {
    // `supabase db push` does not wrap a file in a transaction, so a bare
    // SET LOCAL emits 25P01 and never arms. CLAUDE.md §5.
    expect(CODE).toMatch(/^\s*begin;/m);
    expect(CODE).toMatch(/set local lock_timeout = '5s';/);
    expect(CODE.indexOf("begin;")).toBeLessThan(
      CODE.indexOf("set local lock_timeout"),
    );
    expect(CODE.trimEnd()).toMatch(/commit;$/);
  });
});

describe("0234 adds the two flags in the only shape that is safe to apply", () => {
  for (const column of [
    "client_cancellation_enabled",
    "client_reschedule_enabled",
  ]) {
    it(`${column} is boolean NOT NULL DEFAULT TRUE`, () => {
      // DEFAULT TRUE is what makes applying this migration a no-op for every
      // existing studio. NOT NULL is what stops any code reading absence as
      // "disabled" — a nullable column plus a careless `=== false` check is
      // how a studio would lose self-service without asking.
      expect(FLAT).toContain(
        `add column if not exists ${column} boolean not null default true;`,
      );
    });

    it(`${column} carries a COMMENT`, () => {
      // tests/db/studios-column-comments pins the SET of commented columns on
      // public.studios, so a new commented column must be added there by
      // name. Asserted here too: the comment is where an operator reading the
      // schema learns which command refuses and with which word.
      expect(FLAT).toMatch(
        new RegExp(`comment on column public\\.studios\\.${column} is`),
      );
    });
  }
});

describe("0234 gates the two CLIENT-ONLY commands, and nothing else", () => {
  it("refuses cancellation with `cancellation_disabled`", () => {
    expect(CODE).toContain("'cancellation_disabled'::text");
  });

  it("refuses rescheduling with `reschedule_disabled`", () => {
    expect(CODE).toContain("'reschedule_disabled'::text");
  });

  it("re-emits ONLY the two client commands", () => {
    const created = [...CODE.matchAll(/create or replace function\s+([\w.]+)/g)]
      .map((m) => m[1])
      .sort();
    // The 5-ARGUMENT legacy cancel overload is deliberately ABSENT: it
    // delegates to the 7-argument command and so inherits the refusal. Proven
    // against the deployed body in the DB test (+0/-0), and pinned here so a
    // future edit cannot quietly re-sign it without a gate.
    expect(created).toEqual([
      "public.public_cancel_appointment_with_token",
      "public.reschedule_appointment_v2",
    ]);
  });

  it("touches no STAFF scheduling command", () => {
    // A client-facing rule must not reach staff: disabling client cancellation
    // must never stop the studio cancelling.
    for (const staff of [
      "practitioner_cancel_appointment",
      "move_or_reassign_appointment",
      "receptionist_cancel_appointment",
      "receptionist_move_appointment",
    ]) {
      expect(CODE, `0234 must not redefine ${staff}`).not.toMatch(
        new RegExp(`create or replace function\\s+public\\.${staff}`),
      );
    }
  });

  it("creates or alters no table, policy, trigger or index beyond the two columns", () => {
    expect(CODE).not.toMatch(/create (table|policy|trigger|index|unique)/i);
    expect(CODE).not.toMatch(/drop (table|policy|trigger|function)/i);
    // The ONLY alter table is the additive one that adds the two columns.
    const alters = [...CODE.matchAll(/alter table\s+([\w.]+)/g)].map(
      (m) => m[1],
    );
    expect([...new Set(alters)]).toEqual(["public.studios"]);
  });
});

describe("0234 refuses on the flag only AFTER the state checks (Codex P1 4308948303)", () => {
  // THE DEFECT THIS PINS. The first revision refused on the flag immediately
  // after the studio lock, BEFORE token and state validation — so a cancelled,
  // completed or past appointment at a disabled studio was answered
  // `cancellation_disabled`, and the surface said "your appointment is still
  // booked and has not been changed". False, and it distinguished the studio's
  // policy on a token state the public collapse rule flattens on purpose.
  //
  // ASSERTED HERE, not only in the DB suite, because the DB suite needs a
  // database and this lane does not: a reordering regression reds in validate.
  const bodies = CODE.split("create or replace function").slice(1);

  it("the CANCEL command's flag refusal comes after already_cancelled and not_cancelable", () => {
    const cancel = bodies.find((b) => b.includes("not_cancelable"))!;
    expect(cancel).toBeTruthy();
    const refusal = cancel.indexOf("'cancellation_disabled'::text");
    const alreadyCancelled = cancel.indexOf("'already_cancelled'::text");
    const notCancelable = cancel.indexOf("'not_cancelable'::text");
    expect(refusal).toBeGreaterThan(-1);
    expect(alreadyCancelled).toBeGreaterThan(-1);
    expect(notCancelable).toBeGreaterThan(-1);
    expect(
      refusal,
      "the flag refusal must come AFTER already_cancelled",
    ).toBeGreaterThan(alreadyCancelled);
    expect(
      refusal,
      "the flag refusal must come AFTER the not_cancelable state checks",
    ).toBeGreaterThan(notCancelable);
  });

  it("the RESCHEDULE command's flag refusal comes after appointment_not_reschedulable", () => {
    // Not in the report: the same ordering defect was on this path, for the
    // same reason, and is fixed the same way.
    const res = bodies.find((b) =>
      b.includes("appointment_not_reschedulable"),
    )!;
    expect(res).toBeTruthy();
    const refusal = res.indexOf("'reschedule_disabled'::text");
    const notReschedulable = res.indexOf(
      "'appointment_not_reschedulable'::text",
    );
    expect(refusal).toBeGreaterThan(-1);
    expect(notReschedulable).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(notReschedulable);
  });

  it("both flag VALUES are still read under the studio's FOR UPDATE lock", () => {
    // Only the refusal moved. The read must stay inside the locked studio
    // select, or the decision stops being linearizable against a concurrent
    // policy change — which was the one thing the original ordering got right.
    for (const column of [
      "client_cancellation_enabled",
      "client_reschedule_enabled",
    ]) {
      const read = CODE.indexOf(`coalesce(s.${column}, true)`);
      expect(read, `${column} must be read from the studio row`).toBeGreaterThan(-1);
      const lockAfter = CODE.indexOf("for update", read);
      expect(lockAfter, `${column}'s select must take FOR UPDATE`).toBeGreaterThan(read);
      // and nothing re-reads it from an unlocked statement afterwards
      expect(CODE.indexOf(`coalesce(s.${column}, true)`, read + 1)).toBe(-1);
    }
  });
});

describe("0234: EXECUTE is revoked from every default-granted role BY NAME", () => {
  // Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated
  // AND service_role at function-create time, and `create or replace` re-runs
  // that. Missed once in 0129 (anon) and again in 0164 (service_role).
  // CLAUDE.md §5.
  for (const sig of [CANCEL7, RESCHEDULE]) {
    const name = sig.slice(0, sig.indexOf("("));
    it(`${name} revokes from public, anon, authenticated and service_role`, () => {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        // One revoke may name several roles, or there may be one per role;
        // both appear in this file, so match the ROLE LIST of a revoke for
        // this signature rather than an exact statement.
        const re = new RegExp(
          `revoke execute on function ${sig.replace(/[().]/g, (c) => "\\" + c)} from [^;]*\\b${role}\\b[^;]*;`,
        );
        expect(FLAT, `${name} must revoke from ${role}`).toMatch(re);
      }
    });

    it(`${name} grants EXECUTE back to service_role ONLY`, () => {
      const grants = [
        ...FLAT.matchAll(
          new RegExp(
            `grant execute on function ${sig.replace(/[().]/g, (c) => "\\" + c)} to ([^;]*);`,
            "g",
          ),
        ),
      ].map((m) => m[1].trim());
      expect(grants.length, `no grant found for ${name}`).toBeGreaterThan(0);
      for (const g of grants) {
        expect(g).toBe("service_role");
      }
    });
  }
});

describe("0234 keeps the hardening both commands already had", () => {
  it("every function is SECURITY DEFINER with a pinned search_path", () => {
    const defs = CODE.split("create or replace function").slice(1);
    expect(defs.length).toBe(2);
    for (const d of defs) {
      const body = d.slice(0, d.indexOf("begin"));
      expect(body).toMatch(/security definer/);
      expect(body).toMatch(/set search_path = /);
    }
  });
});
