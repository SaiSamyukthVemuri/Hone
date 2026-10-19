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
// The implementation. Same posture required of it as of the other two: revoked
// from every default-granted role by name, granted back to service_role only.
const RESCHEDULE_V3 =
  "public.reschedule_appointment_v3(uuid, text, timestamptz, text, boolean, text)";

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

  it("re-emits EXACTLY these three functions and no others", () => {
    const created = [...CODE.matchAll(/create or replace function\s+([\w.]+)/g)]
      .map((m) => m[1])
      .sort();
    // THREE, since Codex P2 4309167887. `reschedule_appointment_v3` holds the
    // body and returns the two flags it read under the studio lock;
    // `reschedule_appointment_v2` becomes a thin wrapper over it, kept so an
    // OLD APP BUILD calling v2 keeps working after this migration is applied
    // (the deploy order is migration-first, so that window is real). The
    // implementation had to move to a new name because adding return columns
    // changes the return type, which `create or replace function` refuses
    // (42P13) — dropping a live production command was the alternative.
    //
    // The 5-ARGUMENT legacy cancel overload is still deliberately ABSENT: it
    // delegates to the 7-argument command and so inherits the refusal. Proven
    // against the deployed body in the DB test (+0/-0), and pinned here so a
    // future edit cannot quietly re-sign it without a gate.
    expect(created).toEqual([
      "public.public_cancel_appointment_with_token",
      "public.reschedule_appointment_v2",
      "public.reschedule_appointment_v3",
    ]);
  });

  it("v2 is a WRAPPER over v3, not a second implementation", () => {
    // The whole safety of keeping v2 rests on it having no body of its own: it
    // inherits the HON-47 gate, the lock order, the ordering fix and every
    // refusal code from v3 automatically. A second implementation would be free
    // to drift, and the drift would be invisible — v2 is the name the OLD build
    // calls, so nothing in the new app would exercise it.
    const v2 = CODE.slice(
      CODE.indexOf("create or replace function public.reschedule_appointment_v2("),
    );
    const body = v2.slice(0, v2.indexOf("$$;") + 3);
    expect(body).toContain("public.reschedule_appointment_v3(");
    expect(body).toMatch(/language sql/);
    // It must not re-implement anything: no gate, no locks, no refusal codes.
    expect(body).not.toContain("for update");
    expect(body).not.toContain("reschedule_disabled");
    expect(body).not.toContain("acquire_studio_capacity_lock");
    expect(body).not.toContain("insert into public.appointments");
  });

  it("v2 keeps its ORIGINAL 13-column return shape, in order", () => {
    // The deploy-skew promise: an old build parses these columns positionally
    // and by name. v3's two extra columns must NOT appear here.
    const v2 = CODE.slice(
      CODE.indexOf("create or replace function public.reschedule_appointment_v2("),
    );
    const returns = v2.slice(v2.indexOf("returns table ("), v2.indexOf(")\nlanguage"));
    const cols = [...returns.matchAll(/^\s{2}(\w+)\s+/gm)].map((m) => m[1]);
    expect(cols).toEqual([
      "result",
      "original_appointment_id",
      "new_appointment_id",
      "studio_id",
      "client_id",
      "service_id",
      "practitioner_id",
      "original_starts_at",
      "starts_at",
      "ends_at",
      "duration_minutes",
      "created_at",
      "policy_acknowledgement_id",
    ]);
    expect(cols).not.toContain("client_cancellation_enabled");
    expect(cols).not.toContain("client_reschedule_enabled");
  });

  it("v3 returns the two flags, AFTER the original thirteen", () => {
    const v3 = CODE.slice(
      CODE.indexOf("create or replace function public.reschedule_appointment_v3("),
    );
    const returns = v3.slice(v3.indexOf("returns table ("), v3.indexOf("language plpgsql"));
    const cols = [...returns.matchAll(/^\s{2}(\w+)\s+/gm)].map((m) => m[1]);
    // APPENDED, not inserted: an old build reading v3 positionally would still
    // find its thirteen in place. (It calls v2, but the ordering claim is what
    // makes the wrapper's plain column list safe.)
    expect(cols.slice(0, 13)).toEqual([
      "result",
      "original_appointment_id",
      "new_appointment_id",
      "studio_id",
      "client_id",
      "service_id",
      "practitioner_id",
      "original_starts_at",
      "starts_at",
      "ends_at",
      "duration_minutes",
      "created_at",
      "policy_acknowledgement_id",
    ]);
    expect(cols.slice(13)).toEqual([
      "client_cancellation_enabled",
      "client_reschedule_enabled",
    ]);
  });

  it("v3 reads the cancellation flag UNDER THE STUDIO LOCK, and gates on neither", () => {
    // It returns the cancellation flag; it must not start refusing on it. That
    // is the cancel command's job, and a reschedule that refused because
    // CANCELLATION was off would be a new defect.
    const v3 = CODE.slice(
      CODE.indexOf("create or replace function public.reschedule_appointment_v3("),
    );
    const read = v3.indexOf("coalesce(s.client_cancellation_enabled, true)");
    expect(read, "v3 must read the cancellation flag").toBeGreaterThan(-1);
    expect(v3.indexOf("for update", read)).toBeGreaterThan(read);
    expect(v3).not.toContain("'cancellation_disabled'");
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

  it("EVERY flag read sits inside a studio select that takes FOR UPDATE", () => {
    // Only the refusal moved. Each read must stay inside the locked studio
    // select, or the decision stops being linearizable against a concurrent
    // policy change — which was the one thing the original ordering got right.
    //
    // ASSERTED OVER EVERY OCCURRENCE, not just the first. An earlier version
    // also required there to be exactly ONE read per column, and that stopped
    // being true the moment v3 began RETURNING the cancellation flag as well as
    // the cancel command gating on it (Codex P2 4309167887) — two reads, both
    // legitimate, both under a lock. "Read once" was never the property; "never
    // read outside the lock" is.
    for (const column of [
      "client_cancellation_enabled",
      "client_reschedule_enabled",
    ]) {
      const needle = `coalesce(s.${column}, true)`;
      const reads: number[] = [];
      for (let i = CODE.indexOf(needle); i !== -1; i = CODE.indexOf(needle, i + 1)) {
        reads.push(i);
      }
      expect(reads.length, `${column} must be read from the studio row`).toBeGreaterThan(0);
      for (const read of reads) {
        // The enclosing statement ends at the next `;`. FOR UPDATE must appear
        // inside it, so a read moved into an UNLOCKED select fails here.
        const stmtEnd = CODE.indexOf(";", read);
        const lock = CODE.indexOf("for update", read);
        expect(
          lock !== -1 && lock < stmtEnd,
          `${column} is read at ${read} by a select that does not take FOR UPDATE`,
        ).toBe(true);
      }
    }
  });
});

describe("0234: EXECUTE is revoked from every default-granted role BY NAME", () => {
  // Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated
  // AND service_role at function-create time, and `create or replace` re-runs
  // that. Missed once in 0129 (anon) and again in 0164 (service_role).
  // CLAUDE.md §5.
  for (const sig of [CANCEL7, RESCHEDULE, RESCHEDULE_V3]) {
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
    expect(defs.length).toBe(3);
    for (const d of defs) {
      const body = d.slice(0, d.indexOf("begin"));
      expect(body).toMatch(/security definer/);
      expect(body).toMatch(/set search_path = /);
    }
  });
});
