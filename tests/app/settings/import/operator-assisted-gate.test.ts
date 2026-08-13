import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// IMPORT-01 — the SERVER boundary, exercised for real.
//
// WHAT THIS PROVES AND WHY SOURCE-PINS ARE NOT ENOUGH
// quick-import-action.test.ts greps the action source; that catches a deleted
// gate but not a gate placed after the first write, and not a gate that can be
// walked around by the arguments a caller controls. So this file INVOKES the
// two real server actions against a recording Supabase stub and asserts on the
// statements they actually attempted.
//
// The denial claim is "ZERO writes", so the stub records every insert/update
// on every table — not just the three the import is supposed to touch. A stub
// that only watched the expected tables could not tell the difference between
// "wrote nothing" and "wrote somewhere else".
//
// The operator allowlist is the REAL lib/admin.ts one, driven through
// ADMIN_EMAILS rather than mocked, so the fail-closed production behaviour is
// under test here too.

const practitioner = {
  id: "prac-1",
  role: "owner" as string,
  active: true,
  user_id: "user-1",
  // Deliberately DIFFERENT from the auth email below: the gate must read the
  // verified auth user, never this application-data column.
  email: "practitioner-row@example.com",
};

const authUser: { email: string | null } = { email: "owner@studio.example" };

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner,
    studio: { id: "studio-1" },
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

type Op = { table: string; verb: "insert" | "update"; rows: number };
const ops: Op[] = [];

vi.mock("@/lib/supabase/server", () => {
  function builder(table: string) {
    const state: { verb: string; payload: unknown } = {
      verb: "select",
      payload: null,
    };
    const q: Record<string, unknown> = {};
    const chain = () => q;
    q.select = chain;
    q.eq = chain;
    q.is = chain;
    q.order = chain;
    q.limit = chain;
    q.insert = (payload: unknown) => {
      state.verb = "insert";
      state.payload = payload;
      ops.push({
        table,
        verb: "insert",
        rows: Array.isArray(payload) ? payload.length : 1,
      });
      return q;
    };
    q.update = (payload: unknown) => {
      state.verb = "update";
      state.payload = payload;
      ops.push({ table, verb: "update", rows: 1 });
      return q;
    };
    function result() {
      if (state.verb === "insert") {
        if (table === "import_batches") {
          return { data: { id: "batch-1" }, error: null };
        }
        if (table === "clients") {
          const rows = state.payload as Array<Record<string, unknown>>;
          return {
            data: rows.map((r, i) => ({
              id: `client-${i}`,
              name: r.name,
              email: r.email ?? null,
              phone: r.phone ?? null,
              date_of_birth: r.date_of_birth ?? null,
            })),
            error: null,
          };
        }
        return { data: [], error: null };
      }
      return { data: [], error: null };
    }
    q.single = async () => result();
    q.maybeSingle = async () => result();
    q.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve);
    return q;
  }
  return {
    createClient: async () => ({
      from: (t: string) => builder(t),
      auth: { getUser: async () => ({ data: { user: authUser } }) },
    }),
  };
});

import {
  confirmImportAction,
  previewImportAction,
} from "@/app/(app)/settings/import/actions";
import { IMPORT_OPERATOR_ASSISTED_DENIAL } from "@/lib/import/operator-assist";

const TSV = [
  "client_name\temail\ttreatment_area\tlast_visit_date\tprobe_lot",
  "Maya Gate\tmaya-gate@example.com\tUpper lip\t2024-11-02\tL-204",
  "Maya Gate\tmaya-gate@example.com\tChin\t2024-11-15\tL-205",
  "Jordan Gate\tjordan-gate@example.com\tNeck\t2024-10-01\t",
].join("\n");

const OPERATOR = "operator@hone.care";
const ORDINARY_OWNER = "owner@studio.example";

beforeEach(() => {
  ops.length = 0;
  practitioner.role = "owner";
  practitioner.active = true;
  authUser.email = ORDINARY_OWNER;
  vi.stubEnv("ADMIN_EMAILS", OPERATOR);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function writes(): Op[] {
  return ops;
}

// ---------------------------------------------------------------------------
// 1. The ordinary studio owner — the whole point of the mitigation
// ---------------------------------------------------------------------------

describe("an ordinary studio owner cannot execute the import", () => {
  it("confirm is refused, and refused with the operator-assisted wording", async () => {
    const res = await confirmImportAction(TSV, "paper_card");
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toBe(IMPORT_OPERATOR_ASSISTED_DENIAL);
    expect(!res.ok && res.error).toMatch(/operator-assisted/i);
  });

  it("confirm writes NOTHING — not the batch, not the clients, not anywhere", async () => {
    await confirmImportAction(TSV, "paper_card");
    expect(writes()).toEqual([]);
  });

  it("preview is refused too, so the flow has no half-open first step", async () => {
    const res = await previewImportAction(TSV);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toBe(IMPORT_OPERATOR_ASSISTED_DENIAL);
    expect(writes()).toEqual([]);
  });

  it("the denial is not vacuous: this exact paste DID import before the gate", async () => {
    // Same owner, same text, operator standing granted -> the pipeline runs to
    // completion. Without this, "zero writes" could just mean the fixture was
    // never importable in the first place.
    authUser.email = OPERATOR;
    const res = await confirmImportAction(TSV, "paper_card");
    expect(res.ok).toBe(true);
    expect(res.ok && res.summary.clientsCreated).toBe(2);
    expect(
      writes()
        .filter((o) => o.verb === "insert")
        .map((o) => o.table),
    ).toEqual(["import_batches", "clients", "imported_treatment_memories"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Direct invocation — the UI is not the control
// ---------------------------------------------------------------------------

describe("direct server-action invocation cannot get around it", () => {
  it("calling the action directly is refused (no page render involved)", async () => {
    // Every test in this file already bypasses the page: the action is
    // imported and called as the HTTP endpoint it is. Stated explicitly here
    // because it is the claim the mitigation lives or dies on.
    const res = await confirmImportAction(TSV, "spreadsheet");
    expect(res.ok).toBe(false);
    expect(writes()).toEqual([]);
  });

  it("no source_type value unlocks it", async () => {
    for (const source of [
      "paper_card",
      "spreadsheet",
      "jane",
      "fresha",
      "other",
      "",
      "admin",
      "operator",
      "../../etc",
    ]) {
      ops.length = 0;
      const res = await confirmImportAction(TSV, source);
      expect(res.ok, `source_type "${source}" passed the gate`).toBe(false);
      expect(writes(), `source_type "${source}" wrote`).toEqual([]);
    }
  });

  it("no paste shape unlocks it — empty, huge, or crafted", async () => {
    const huge = [
      "client_name\temail\ttreatment_area",
      ...Array.from(
        { length: 500 },
        (_, i) => `Bulk ${i}\tbulk-${i}@example.com\tUpper lip`,
      ),
    ].join("\n");
    for (const text of ["", "   ", "client_name\nOnly Header", TSV, huge]) {
      ops.length = 0;
      const res = await confirmImportAction(text, "paper_card");
      expect(res.ok).toBe(false);
      expect(writes()).toEqual([]);
    }
  });

  it("the practitioner-row email is NOT an authorization signal", async () => {
    // A practitioners.email that happens to be on the allowlist must not grant
    // operator standing; only the verified auth user counts.
    practitioner.email = OPERATOR;
    authUser.email = ORDINARY_OWNER;
    const res = await confirmImportAction(TSV, "paper_card");
    expect(res.ok).toBe(false);
    expect(writes()).toEqual([]);
    practitioner.email = "practitioner-row@example.com";
  });
});

// ---------------------------------------------------------------------------
// 3. The gate composes with the existing owner gate, and fails closed
// ---------------------------------------------------------------------------

describe("the operator check is additional to ownership, never instead of it", () => {
  it("a non-owner is still refused first, with the owner message", async () => {
    practitioner.role = "practitioner";
    authUser.email = OPERATOR;
    const res = await confirmImportAction(TSV, "paper_card");
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/only studio owners can import/i);
    expect(writes()).toEqual([]);
  });

  it("an INACTIVE owner is refused even with operator standing", async () => {
    practitioner.active = false;
    authUser.email = OPERATOR;
    const res = await confirmImportAction(TSV, "paper_card");
    expect(res.ok).toBe(false);
    expect(writes()).toEqual([]);
  });

  it("an anonymous caller (no auth user) cannot be an operator", async () => {
    authUser.email = null;
    const res = await confirmImportAction(TSV, "paper_card");
    expect(res.ok).toBe(false);
    expect(writes()).toEqual([]);
  });

  it("fails CLOSED in production when ADMIN_EMAILS is unset", async () => {
    // lib/admin.ts drops its dev-convenience fallback in production, so an
    // unconfigured prod deploy denies everyone rather than defaulting open.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_EMAILS", "");
    for (const email of [OPERATOR, ORDINARY_OWNER, "samyukth.ssv@gmail.com"]) {
      ops.length = 0;
      authUser.email = email;
      const res = await confirmImportAction(TSV, "paper_card");
      expect(res.ok, `${email} executed with no ADMIN_EMAILS in production`).toBe(
        false,
      );
      expect(writes()).toEqual([]);
    }
  });

  it("allowlist matching is case-insensitive but not prefix-loose", async () => {
    vi.stubEnv("ADMIN_EMAILS", OPERATOR);
    authUser.email = "OPERATOR@HONE.CARE";
    expect((await confirmImportAction(TSV, "paper_card")).ok).toBe(true);

    for (const nearMiss of [
      "operator@hone.care.attacker.example",
      "xoperator@hone.care",
      "operator@hone.car",
      "operator+alias@hone.care",
    ]) {
      ops.length = 0;
      authUser.email = nearMiss;
      const res = await confirmImportAction(TSV, "paper_card");
      expect(res.ok, `${nearMiss} passed the allowlist`).toBe(false);
      expect(writes()).toEqual([]);
    }
  });
});
