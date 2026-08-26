import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  auditColumnCoverage,
  auditResourceCoverage,
  CUSTOMER_RESOURCE_SCHEMA,
  EXPORT_RESOURCE_REGISTRY,
  exportedResources,
  NON_CUSTOMER_SCHEMAS,
  pendingResources,
  STORAGE_RESOURCE_PREFIX,
} from "@/lib/export/resource-registry";
import { adminQuery, closePool } from "@/tests/db/helpers/harness";
import {
  computeReachability,
  deadClaimViolations,
  type ReachabilityGraph,
} from "@/tests/db/helpers/reachability";

// ===========================================================================
// GUARDS 1 AND 2 — proved against the REAL migrated schema
// ===========================================================================
//
// THE SCHEMA AUTHORITY IS THE DATABASE. Not migration text, and not the
// generated types.
//
// Deriving the table and column inventory by scanning supabase/migrations/*.sql
// would be the obvious shortcut and it is not sound: migrations rename, drop,
// guard themselves with IF EXISTS / IF NOT EXISTS, and execute procedural SQL
// inside DO blocks. A regex sees the CREATE and misses every one of those, so
// it would report a table that no longer exists and miss a column added inside
// a conditional block — and a guard that is confidently wrong about the schema
// is worse than no guard, because it retires the suspicion that would have
// found the gap.
//
// So these two guards introspect information_schema and pg_catalog on the
// fully migrated LOCAL Supabase stack. Prerequisite:
//
//   supabase db start && npx --yes supabase@2.102.0 db reset --local
//
// Nothing here writes. The one test that creates a table does so inside a
// transaction that is ALWAYS rolled back, because this stack is shared with
// every other suite in the lane.


// ---------------------------------------------------------------------------
// Does APPLICATION code reference a symbol?
//
// Comments are stripped so prose describing a table does not count as using it,
// and the registry itself is skipped: naming every table is its entire job.
// ---------------------------------------------------------------------------
const APP_ROOTS = ["app", "lib", "components"] as const;
const NOT_A_REFERENCE = new Set([
  "lib/export/resource-registry.ts",
  "lib/types/database.ts",
]);

function walkTs(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

let APP_SOURCES: Array<{ rel: string; code: string }> | null = null;

function appSources(): Array<{ rel: string; code: string }> {
  if (APP_SOURCES) return APP_SOURCES;
  APP_SOURCES = [];
  for (const root of APP_ROOTS) {
    for (const rel of walkTs(root)) {
      if (NOT_A_REFERENCE.has(rel)) continue;
      const raw = readFileSync(rel, "utf8");
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !/^\s*\/\//.test(line))
        .join("\n");
      APP_SOURCES.push({ rel, code });
    }
  }
  return APP_SOURCES;
}

/** Files that use `symbol` as a real string literal, not as prose. */
function referencedBy(symbol: string): string[] {
  return appSources()
    .filter(
      ({ code }) =>
        code.includes(`"${symbol}"`) ||
        code.includes(`'${symbol}'`) ||
        code.includes(`\`${symbol}\``),
    )
    .map(({ rel }) => rel);
}

let liveTables: string[] = [];
let liveBuckets: string[] = [];
let liveColumns: Record<string, string[]> = {};

beforeAll(async () => {
  const tables = await adminQuery(
    `select table_name
       from information_schema.tables
      where table_schema = $1
        and table_type = 'BASE TABLE'
      order by table_name`,
    [CUSTOMER_RESOURCE_SCHEMA],
  );
  liveTables = tables.rows.map((r: { table_name: string }) => r.table_name);

  const buckets = await adminQuery(`select id from storage.buckets order by id`);
  liveBuckets = buckets.rows.map(
    (r: { id: string }) => `${STORAGE_RESOURCE_PREFIX}${r.id}`,
  );

  const columns = await adminQuery(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = $1
      order by table_name, ordinal_position`,
    [CUSTOMER_RESOURCE_SCHEMA],
  );
  liveColumns = {};
  for (const row of columns.rows as Array<{
    table_name: string;
    column_name: string;
  }>) {
    (liveColumns[row.table_name] ??= []).push(row.column_name);
  }
});

afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------
// The universe rule, asserted rather than assumed
// ---------------------------------------------------------------------------
describe("the customer-resource universe is exactly what the rule says", () => {
  it("the migrated schema really does hold tables in public", () => {
    expect(liveTables.length).toBeGreaterThan(50);
  });

  it("every schema the rule excludes is either absent or genuinely platform-owned", async () => {
    const present = await adminQuery(
      `select nspname from pg_namespace where nspname not like 'pg\\_%' order by nspname`,
    );
    const names = present.rows.map((r: { nspname: string }) => r.nspname);
    const unaccounted = names.filter(
      (n: string) => n !== CUSTOMER_RESOURCE_SCHEMA && !(n in NON_CUSTOMER_SCHEMAS),
    );
    // A NEW schema appearing is a decision somebody has to make, not something
    // this guard should shrug at: it could be where the next studio-owned table
    // lands.
    expect(unaccounted, "a schema exists that the universe rule does not name").toEqual([]);
  });

  it("views are outside the universe, so nothing is exported twice", async () => {
    const views = await adminQuery(
      `select table_name from information_schema.views where table_schema = $1`,
      [CUSTOMER_RESOURCE_SCHEMA],
    );
    for (const row of views.rows as Array<{ table_name: string }>) {
      expect(
        EXPORT_RESOURCE_REGISTRY[row.table_name],
        `view ${row.table_name} should not carry a disposition`,
      ).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// GUARD 1
// ---------------------------------------------------------------------------
describe("guard 1: every live resource has exactly one disposition", () => {
  it("no live table or bucket is missing from the registry", () => {
    const audit = auditResourceCoverage([...liveTables, ...liveBuckets]);
    expect(
      audit.unregistered,
      "these exist in the database and no one has decided whether a studio gets them",
    ).toEqual([]);
  });

  it("no registry entry describes something the database does not have", () => {
    const audit = auditResourceCoverage([...liveTables, ...liveBuckets]);
    expect(
      audit.stale,
      "these are declared in the registry but were renamed or dropped",
    ).toEqual([]);
  });

  it("the private treatment-images bucket is one of the resources", () => {
    expect(liveBuckets).toContain("storage:treatment-images");
    expect(EXPORT_RESOURCE_REGISTRY["storage:treatment-images"]).toBeDefined();
  });

  it("a disposition is one of exactly three kinds, and every entry has one", () => {
    for (const [resource, disposition] of Object.entries(EXPORT_RESOURCE_REGISTRY)) {
      expect(
        ["exported", "excluded", "pending"],
        `${resource} has an unrecognised disposition`,
      ).toContain(disposition.kind);
    }
  });

  // NEGATIVE CONTROL. Create a real table, prove the introspection sees it and
  // the guard goes RED, then roll the whole thing back. The rollback is forced
  // by throwing: adminTx commits on a clean return, and this stack is shared.
  it("RED when a genuinely new table appears in the database", async () => {
    const { adminTx } = await import("@/tests/db/helpers/harness");
    class Rollback extends Error {}
    let sawUnregistered: readonly string[] = [];
    await expect(
      adminTx(async (query) => {
        await query(
          `create table public.zz_truth01_synthetic_probe (id uuid primary key)`,
        );
        const inTx = await query(
          `select table_name from information_schema.tables
            where table_schema = 'public' and table_type = 'BASE TABLE'`,
        );
        const names = inTx.rows.map((r: { table_name: string }) => r.table_name);
        sawUnregistered = auditResourceCoverage([...names, ...liveBuckets]).unregistered;
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);

    expect(sawUnregistered).toEqual(["zz_truth01_synthetic_probe"]);

    // And the table is gone, so the suite left the shared stack as it found it.
    const after = await adminQuery(
      `select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'zz_truth01_synthetic_probe'`,
    );
    expect(after.rowCount).toBe(0);
  });

  it("RED for an unregistered resource, GREEN for the real set (fixture control)", () => {
    const real = [...liveTables, ...liveBuckets];
    expect(auditResourceCoverage(real).ok).toBe(true);
    const audit = auditResourceCoverage([...real, "zz_fixture_unregistered"]);
    expect(audit.ok).toBe(false);
    expect(audit.unregistered).toEqual(["zz_fixture_unregistered"]);
  });

  it("RED for a registry entry the database no longer has (fixture control)", () => {
    const audit = auditResourceCoverage(
      [...liveTables, ...liveBuckets].filter((r) => r !== "clients"),
    );
    expect(audit.ok).toBe(false);
    expect(audit.stale).toEqual(["clients"]);
  });
});

// ---------------------------------------------------------------------------
// GUARD 2
// ---------------------------------------------------------------------------
describe("guard 2: every column of an exported table is accounted for", () => {
  it("included UNION excluded equals the live column set, for every exported table", () => {
    const audit = auditColumnCoverage(liveColumns);
    expect(audit.problems, JSON.stringify(audit.problems, null, 2)).toEqual([]);
  });

  it("included and excluded are disjoint", () => {
    for (const { resource, disposition } of exportedResources()) {
      const included = new Set(disposition.includedColumns);
      const overlap = disposition.excludedColumns
        .map((c) => c.column)
        .filter((c) => included.has(c));
      expect(overlap, `${resource} lists a column twice`).toEqual([]);
    }
  });

  it("the guard catches a column that exists only in the database", () => {
    const tampered = {
      ...liveColumns,
      clients: [...liveColumns.clients, "zz_new_clinical_field"],
    };
    const audit = auditColumnCoverage(tampered);
    expect(audit.ok).toBe(false);
    expect(audit.problems).toContainEqual({
      resource: "clients",
      kind: "unaccounted_column",
      detail:
        '"zz_new_clinical_field" exists in the database and is in neither includedColumns nor excludedColumns',
    });
  });

  it("the guard catches a real included column vanishing from the database", () => {
    const tampered = {
      ...liveColumns,
      clients: liveColumns.clients.filter((c) => c !== "allergies"),
    };
    const audit = auditColumnCoverage(tampered);
    expect(audit.ok).toBe(false);
    expect(audit.problems.map((p) => p.kind)).toContain("phantom_column");
  });

  it("the guard catches a missing live column list for an exported table", () => {
    const { clients: _dropped, ...withoutClients } = liveColumns;
    const audit = auditColumnCoverage(withoutClients);
    expect(audit.ok).toBe(false);
    expect(audit.problems[0].kind).toBe("phantom_column");
  });

  it("an omission is recorded as pending_review, so a real gap stays visible", () => {
    const pendingByTable = new Map<string, string[]>();
    for (const { resource, disposition } of exportedResources()) {
      const pending = disposition.excludedColumns
        .filter((c) => c.reason === "pending_review")
        .map((c) => c.column);
      if (pending.length > 0) pendingByTable.set(resource, pending);
    }
    // The four the recon named, none of them hard-coded into the MECHANISM —
    // the mechanism is set arithmetic against the database. They are asserted
    // here only to prove the accounting reached the columns that motivated it.
    expect(pendingByTable.get("clients")).toContain("contraindications");
    expect(pendingByTable.get("clients")).toContain("photo_consent");
    expect(pendingByTable.get("laser_entries")).toContain("ejection_results");
    expect(pendingByTable.get("electrolysis_entries")).toContain("pulse_delay_seconds");
  });

  it("every pending_review column says what the studio does not get", () => {
    for (const { resource, disposition } of exportedResources()) {
      for (const column of disposition.excludedColumns) {
        if (column.reason !== "pending_review") continue;
        expect(
          (column.note ?? "").trim().length,
          `${resource}.${column.column} is a bare admission with no explanation`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The exclusions are decisions, not hiding places
// ---------------------------------------------------------------------------
describe("what is excluded, and on what grounds", () => {
  it("credential-bearing tables are permanently EXCLUDED, never PENDING", () => {
    for (const resource of [
      "calendar_connection_secrets",
      "google_oauth_states",
      "client_portal_magic_links",
      "client_portal_sessions",
    ]) {
      const disposition = EXPORT_RESOURCE_REGISTRY[resource];
      expect(disposition.kind, `${resource} must be a decision, not a backlog item`).toBe(
        "excluded",
      );
      expect(disposition.kind === "excluded" && disposition.category).toBe("security");
    }
  });

  it("no exported table emits a column whose exclusion reason is security_material", () => {
    for (const { resource, disposition } of exportedResources()) {
      const secret = disposition.excludedColumns
        .filter((c) => c.reason === "security_material")
        .map((c) => c.column);
      for (const column of secret) {
        expect(
          disposition.csvHeaders,
          `${resource}.${column} is security material and must not be a header`,
        ).not.toContain(column);
        expect(disposition.includedColumns).not.toContain(column);
      }
    }
  });

  // -------------------------------------------------------------------------
  // "DEAD" IS A CLAIM ABOUT THE RUNTIME, AND IT IS NOW CHECKED
  // -------------------------------------------------------------------------
  //
  // Codex P2 on head 25c066ab: stripe_account_provisioning_attempts and
  // stripe_customer_provisioning_attempts were classified `dead`. They are not.
  // Both are written by SECURITY DEFINER functions the application calls, and
  // the mistake came from a liveness check that looked only for direct table
  // access. A table written exclusively through an RPC was invisible to it —
  // and the false claim was being PRINTED into the generated README and
  // settings page, which is the precise class of untruth this registry exists
  // to remove.
  //
  // So the claim is now mechanical, and it uses pg_proc rather than the
  // migration text: for every `dead` resource, no application module may
  // reference the table, and no function that WRITES the table may be invoked
  // from application code.
  // -------------------------------------------------------------------------
  // DEAD IS A TRANSITIVE CLAIM, AND IT IS NOW CHECKED TRANSITIVELY
  // -------------------------------------------------------------------------
  //
  // Two narrower versions were caught in review. Writers-only missed
  // appointment_payments, which is READ by two application-called RPCs.
  // Direct-only missed indirection entirely: an application RPC that reaches a
  // resource through a helper, or an application write whose TRIGGER function
  // reaches it, because the function that actually touches the table is never
  // named in application source.
  //
  // The graph is built from the LIVE catalogue — pg_proc bodies, pg_trigger,
  // pg_class — never from migration text, and the closure lives in
  // tests/db/helpers/reachability.ts so the same algorithm can be driven by
  // fixtures for the shapes this schema happens not to contain.
  async function buildLiveGraph(): Promise<ReachabilityGraph> {
    const procs = await adminQuery(
      `select p.proname, p.prosrc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'`,
    );
    const functions = procs.rows as Array<{ proname: string; prosrc: string }>;
    const fnNames = [...new Set(functions.map((f) => f.proname))];

    const tablesRes = await adminQuery(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const tableNames = (tablesRes.rows as Array<{ table_name: string }>).map(
      (r) => r.table_name,
    );

    const trg = await adminQuery(
      `select c.relname as table_name, p.proname as fn
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_proc p on p.oid = t.tgfoid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and not t.tgisinternal`,
    );

    const bodyByFn = new Map<string, string>();
    for (const f of functions) {
      bodyByFn.set(f.proname, (bodyByFn.get(f.proname) ?? "") + " " + f.prosrc);
    }

    const functionCalls: Record<string, string[]> = {};
    const functionTables: Record<string, string[]> = {};
    for (const [name, body] of bodyByFn) {
      functionCalls[name] = fnNames.filter(
        (other) => other !== name && new RegExp(String.raw`\b${other}\b`).test(body),
      );
      functionTables[name] = tableNames.filter((t) =>
        new RegExp(String.raw`\b${t}\b`).test(body),
      );
    }

    const tableTriggers: Record<string, string[]> = {};
    for (const row of trg.rows as Array<{ table_name: string; fn: string }>) {
      (tableTriggers[row.table_name] ??= []).push(row.fn);
    }

    // Application entrypoints, from source: an RPC name used as a string
    // literal, and a table opened with .from("...").
    const appFunctions = fnNames.filter((n) => referencedBy(n).length > 0);
    const appTables = [
      ...new Set(
        appSources().flatMap(({ code }) =>
          [...code.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]),
        ),
      ),
    ].filter((t) => tableNames.includes(t));

    return { functionCalls, functionTables, tableTriggers, appFunctions, appTables };
  }

  it("the live graph really has application entrypoints (anti-vacuity)", async () => {
    const graph = await buildLiveGraph();
    expect(graph.appFunctions.length).toBeGreaterThan(50);
    expect(graph.appTables.length).toBeGreaterThan(20);
    const reach = computeReachability(graph);
    // If the closure reached almost nothing, every dead claim below would pass
    // for the wrong reason.
    expect(reach.functions.size).toBeGreaterThan(graph.appFunctions.length);
    expect(reach.tables.size).toBeGreaterThan(graph.appTables.length);
  });

  it("no resource classified dead is reachable from the application, at any depth", async () => {
    const dead = Object.entries(EXPORT_RESOURCE_REGISTRY)
      .filter(([, d]) => d.kind === "excluded" && d.category === "dead")
      .map(([resource]) => resource);
    expect(dead.length).toBeGreaterThan(0);
    const reach = computeReachability(await buildLiveGraph());
    expect(
      deadClaimViolations(dead, reach),
      "classified dead, but an application path reaches it — reclassify as pending",
    ).toEqual([]);
  });

  it("the closure would still catch the direct reader case that started this", async () => {
    // appointment_payments is no longer classified dead, so the real sweep
    // cannot exercise it. Ask the closure about it directly instead.
    const reach = computeReachability(await buildLiveGraph());
    expect(reach.tables.has("appointment_payments")).toBe(true);
    expect(reach.pathTo.get("appointment_payments")).toMatch(
      /reschedule_appointment_v2|appointment_has_blocking_dependents/,
    );
  });

  // ---------------------------------------------------------------------
  // CONTROLS A-I. Fixture graphs, so every shape is exercised whether or not
  // the installed schema happens to contain one.
  // ---------------------------------------------------------------------
  const empty: ReachabilityGraph = {
    functionCalls: {},
    functionTables: {},
    tableTriggers: {},
    appFunctions: [],
    appTables: [],
  };
  const violations = (g: Partial<ReachabilityGraph>) =>
    deadClaimViolations(["dead_resource"], computeReachability({ ...empty, ...g }));

  it("CONTROL A — app -> RPC -> helper -> resource is RED", () => {
    expect(
      violations({
        appFunctions: ["rpc_a"],
        functionCalls: { rpc_a: ["helper_b"] },
        functionTables: { helper_b: ["dead_resource"] },
      }),
    ).toEqual(["dead_resource is reachable: app -> rpc_a -> helper_b -> dead_resource"]);
  });

  it("CONTROL B — app -> RPC -> helper -> helper -> resource is RED", () => {
    const v = violations({
      appFunctions: ["rpc_a"],
      functionCalls: { rpc_a: ["helper_b"], helper_b: ["helper_c"] },
      functionTables: { helper_c: ["dead_resource"] },
    });
    expect(v.length).toBe(1);
    expect(v[0]).toContain("rpc_a -> helper_b -> helper_c -> dead_resource");
  });

  it("CONTROL C — app write -> trigger -> trigger function -> resource is RED", () => {
    const v = violations({
      appTables: ["appointments"],
      tableTriggers: { appointments: ["trg_fn"] },
      functionTables: { trg_fn: ["dead_resource"] },
    });
    expect(v.length).toBe(1);
    expect(v[0]).toContain("appointments -> trg_fn -> dead_resource");
  });

  it("CONTROL D — app -> RPC -> helper -> written table -> trigger fn -> resource is RED", () => {
    const v = violations({
      appFunctions: ["rpc_a"],
      functionCalls: { rpc_a: ["helper_b"], trg_fn: ["deep_fn"] },
      functionTables: { helper_b: ["sessions"], deep_fn: ["dead_resource"] },
      tableTriggers: { sessions: ["trg_fn"] },
    });
    expect(v.length).toBe(1);
    expect(v[0]).toContain(
      "rpc_a -> helper_b -> sessions -> trg_fn -> deep_fn -> dead_resource",
    );
  });

  it("CONTROL E — the application opens the resource directly is RED", () => {
    expect(violations({ appTables: ["dead_resource"] })).toEqual([
      "dead_resource is reachable: app -> dead_resource",
    ]);
  });

  it("CONTROL F — app -> live writer function -> resource is RED", () => {
    expect(
      violations({
        appFunctions: ["writer_fn"],
        functionTables: { writer_fn: ["dead_resource"] },
      }),
    ).toEqual(["dead_resource is reachable: app -> writer_fn -> dead_resource"]);
  });

  it("CONTROL G — a helper chain with NO application entrypoint is GREEN", () => {
    expect(
      violations({
        functionCalls: { orphan_a: ["orphan_b"] },
        functionTables: { orphan_b: ["dead_resource"] },
      }),
    ).toEqual([]);
  });

  it("CONTROL H — a cycle with no application entrypoint is GREEN and terminates", () => {
    const started = Date.now();
    expect(
      violations({
        functionCalls: { cyc_a: ["cyc_b"], cyc_b: ["cyc_c"], cyc_c: ["cyc_a"] },
        functionTables: { cyc_c: ["dead_resource"] },
      }),
    ).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("CONTROL I — a cycle reachable from the app that touches the resource is RED and terminates", () => {
    const started = Date.now();
    const v = violations({
      appFunctions: ["cyc_a"],
      functionCalls: { cyc_a: ["cyc_b"], cyc_b: ["cyc_c"], cyc_c: ["cyc_a", "cyc_b"] },
      functionTables: { cyc_c: ["dead_resource"] },
    });
    expect(v.length).toBe(1);
    expect(v[0]).toContain("dead_resource");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("appointment_payments is pending with field review, not dead", () => {
    const disposition = EXPORT_RESOURCE_REGISTRY.appointment_payments;
    expect(disposition.kind).toBe("pending");
    expect(disposition.kind === "pending" && disposition.fieldReviewRequired).toBe(true);
    expect(disposition.kind === "pending" && disposition.reason).toMatch(
      /reschedule_appointment_v2/,
    );
  });

  it("the two Stripe provisioning ledgers Codex found are pending, not dead", () => {
    for (const resource of [
      "stripe_account_provisioning_attempts",
      "stripe_customer_provisioning_attempts",
    ]) {
      const disposition = EXPORT_RESOURCE_REGISTRY[resource];
      expect(disposition.kind, `${resource}`).toBe("pending");
      expect(
        disposition.kind === "pending" && disposition.fieldReviewRequired,
        `${resource} carries provider identifiers and must not be dumped raw`,
      ).toBe(true);
    }
  });

  // No emitted reason may make a zero-readers/zero-writers claim: that sentence
  // was printed to owners about appointment_payments and was false.
  it("no owner-facing reason claims zero readers or zero writers", () => {
    for (const [resource, disposition] of Object.entries(EXPORT_RESOURCE_REGISTRY)) {
      const reason =
        disposition.kind === "exported" ? disposition.description : disposition.reason;
      expect(reason, `${resource}`).not.toMatch(/zero (readers|writers)/i);
      expect(reason, `${resource}`).not.toMatch(/no readers/i);
    }
  });

  it("every excluded resource carries a substantive reason", () => {
    for (const [resource, disposition] of Object.entries(EXPORT_RESOURCE_REGISTRY)) {
      if (disposition.kind !== "excluded") continue;
      expect(
        disposition.reason.trim().length,
        `${resource} is excluded with no stated reason`,
      ).toBeGreaterThan(40);
    }
  });

  it("every pending resource carries a ticket, a tier and a reason", () => {
    for (const { resource, disposition } of pendingResources()) {
      expect(disposition.ticket, `${resource}`).toMatch(/^TRUTH-01[A-Z]$/);
      expect([1, 2]).toContain(disposition.tier);
      expect(disposition.reason.trim().length, `${resource}`).toBeGreaterThan(40);
    }
  });

  it("the money, audit and provider tables are flagged for field review, not queued for a raw dump", () => {
    for (const resource of [
      "payment_charge_attempts",
      "audit_logs",
      "appointment_audit",
      "client_stripe_customers",
      "studio_payment_settings",
    ]) {
      const disposition = EXPORT_RESOURCE_REGISTRY[resource];
      expect(disposition.kind).toBe("pending");
      expect(
        disposition.kind === "pending" && disposition.fieldReviewRequired,
        `${resource} must not be exported raw without a field decision`,
      ).toBe(true);
    }
  });
});
