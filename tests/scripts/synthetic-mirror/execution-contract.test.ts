import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs module without types
import { ALLOWED_COLUMNS, ALLOWED_VALUES, BODY_KEYS, CEILINGS, ENTITY_IDENTITY, ENTITY_ORDER, ENTITY_TABLE, ENVELOPE_KEYS, MUST_BE_NULL, SCHEMA_VERSION } from "../../../scripts/synthetic-mirror/plan-schema.mjs";
// @ts-expect-error — .mjs module without types
import { buildPlanDocument } from "../../../scripts/synthetic-mirror/export.mjs";
// @ts-expect-error — .mjs module without types
import { verifyPlan, verifyResetSelection } from "../../../scripts/synthetic-mirror/verify-plan.mjs";
// @ts-expect-error — .mjs module without types
import { canonicalize, digestBody } from "../../../scripts/synthetic-mirror/plan-digest.mjs";
// @ts-expect-error — .mjs module without types
import { deriveSyntheticId } from "../../../scripts/synthetic-mirror/identity.mjs";

const ROOT = join(__dirname, "..", "..", "..");
const TARGET = "0b5f4c1e-31a7-4d92-8f60-2c7e9a4d1b83";
const SOURCE = "38cb3a8b-0000-4000-8000-000000000001";
const PRACTITIONER = "1c6a5d2f-42b8-4e03-9071-3d8fab5e2c94";
const SERVICES = ["2d7b6e3a-53c9-4f14-8182-4e9abc6f3da5"];

const PROFILE = {
  clients_total: 20, clients_with_upcoming: 12,
  appt_confirmed: 20, appt_completed: 14, appt_cancelled: 8, appt_no_show: 1,
  intake_in_progress: 7, intake_submitted: 4, intake_reviewed: 9,
  sessions_total: 18, sessions_missing_aftercare: 8, sessions_with_next_note: 9,
};
const EMPTY = {
  syntheticClients: 0, syntheticAppointments: 0, syntheticSessions: 0, syntheticIntakes: 0,
};

const ANCHOR = Date.UTC(2026, 7, 9);
const build = () =>
  buildPlanDocument({
    sourceProfile: PROFILE,
    targetCensus: EMPTY,
    targetStudioId: TARGET,
    practitionerId: PRACTITIONER,
    serviceIds: SERVICES,
    anchorMs: ANCHOR,
    generatedAt: "2026-08-09T00:00:00.000Z",
  });

const EXPECTED = {
  targetStudioId: TARGET,
  sourceStudioId: SOURCE,
  practitionerId: PRACTITIONER,
  serviceIds: SERVICES,
};

/** Executable code only — comments stripped. See privacy.test.ts for why. */
const codeOf = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

// The plan document is deliberately untyped here: these tests exercise the
// runtime contract, including shapes TypeScript would reject.
/* eslint-disable @typescript-eslint/no-explicit-any */
const clone = (p: unknown): any => JSON.parse(JSON.stringify(p));
/** Mutate then RE-SEAL, so each assertion proves its own rule, not the digest. */
const reseal = (p: any): any => { p.plan_id = digestBody(p.body); return p; };

describe("plan format is CLOSED", () => {
  const plan = build();

  it("declares an exact schema version", () => {
    expect(plan.schema_version).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("has only the allowed envelope and body keys", () => {
    expect(Object.keys(plan).sort()).toEqual([...(ENVELOPE_KEYS as string[])].sort());
    expect(Object.keys(plan.body).sort()).toEqual([...(BODY_KEYS as string[])].sort());
  });

  it("carries only allowlisted entities, in dependency-safe order", () => {
    expect(Object.keys(plan.body.entities).sort()).toEqual([...(ENTITY_ORDER as string[])].sort());
    // clients before their children; appointments before the sessions that
    // chart them; sessions before their blocks.
    const order = ENTITY_ORDER as string[];
    expect(order.indexOf("clients")).toBeLessThan(order.indexOf("appointments"));
    expect(order.indexOf("appointments")).toBeLessThan(order.indexOf("sessions"));
    expect(order.indexOf("sessions")).toBeLessThan(order.indexOf("session_blocks"));
  });

  it("writes only allowlisted columns on every row", () => {
    for (const entity of ENTITY_ORDER as string[]) {
      const allowed = new Set(ALLOWED_COLUMNS[entity] as string[]);
      for (const row of plan.body.entities[entity]) {
        for (const col of Object.keys(row)) expect(allowed.has(col), `${entity}.${col}`).toBe(true);
      }
    }
  });

  it("maps each entity to a fixed physical table — never a caller-supplied name", () => {
    for (const entity of ENTITY_ORDER as string[]) {
      expect(typeof ENTITY_TABLE[entity]).toBe("string");
      expect(ENTITY_IDENTITY[entity]).toBeTruthy();
    }
    // The schema must not carry connection details as DATA. Checked against
    // code: the header legitimately explains that a connection string is one of
    // the things the format deliberately cannot express.
    expect(codeOf("scripts/synthetic-mirror/plan-schema.mjs")).not.toMatch(
      /connection|postgres:|password|host/i,
    );
  });

  it("uses only the tables' own CHECK vocabularies", () => {
    for (const [entity, cols] of Object.entries(ALLOWED_VALUES as Record<string, Record<string, unknown[]>>)) {
      for (const [col, vals] of Object.entries(cols)) {
        for (const row of plan.body.entities[entity] ?? []) {
          if (col in row) expect(vals).toContain(row[col]);
        }
      }
    }
  });

  it("expected_counts matches the rows actually carried", () => {
    for (const entity of ENTITY_ORDER as string[]) {
      expect(plan.body.expected_counts[entity]).toBe(plan.body.entities[entity].length);
    }
  });
});

describe("plan is reproducible", () => {
  it("regenerates byte-identically from the same inputs", () => {
    expect(canonicalize(build().body)).toBe(canonicalize(build().body));
    expect(build().plan_id).toBe(build().plan_id);
  });

  it("changes its digest when any content changes", () => {
    const a = build();
    const b = clone(a);
    b.body.entities.clients[0].name = "Different";
    expect(digestBody(b.body)).not.toBe(a.plan_id);
  });

  it("canonicalizes key order, so formatting cannot change the digest", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("documents the digest as integrity-only, never authorship", () => {
    const src = readFileSync(join(ROOT, "scripts/synthetic-mirror/plan-digest.mjs"), "utf8");
    expect(src).toMatch(/not a signature/i);
    expect(src).toMatch(/unkeyed/i);
    expect(src).toMatch(/proves nothing about authorship/i);
  });

  it("does not let a matching digest authorize anything on its own", () => {
    // The real guarantee, stated behaviourally rather than by grepping prose:
    // re-seal a tampered plan and it is STILL refused, because the semantic
    // rules are evaluated independently of the digest.
    const p = reseal(clone(build()));
    p.body.entities.clients[0].email = "attacker@example.org";
    reseal(p);
    const v = verifyPlan(p, EXPECTED) as string[];
    expect(v.join(" ")).toContain("email must be null");
    expect(v.join(" ")).not.toContain("integrity check failed");
  });
});

describe("plan privacy", () => {
  const plan = build();
  const serialized = JSON.stringify(plan);

  it("carries no source studio, client, appointment or session identifier", () => {
    expect(serialized).not.toContain(SOURCE);
    // source_profile is counts only.
    for (const v of Object.values(plan.body.source_profile)) expect(Number.isInteger(v)).toBe(true);
  });

  it("carries no contact detail on any generated client", () => {
    for (const c of plan.body.entities.clients) {
      for (const col of MUST_BE_NULL.clients as string[]) expect(c[col]).toBeNull();
    }
    expect(serialized).not.toMatch(/@(gmail|icloud|hotmail|outlook|yahoo)\.com/);
  });

  it("carries no provider, payment or token identifier", () => {
    for (const term of [
      "stripe", "payment_intent", "payment_method", "customer_id",
      "google_event", "message_sid", "cancellation_token", "ip_address",
    ]) {
      expect(serialized.toLowerCase().includes(term), term).toBe(false);
    }
  });

  it("has no source→synthetic mapping structure anywhere", () => {
    expect(Object.keys(plan.body)).not.toContain("mapping");
    expect(serialized).not.toMatch(/sourceClientId|source_client_id/i);
  });
});

describe("verifier refuses everything it must", () => {
  it("accepts a well-formed plan", () => {
    expect(verifyPlan(build(), EXPECTED)).toEqual([]);
  });

  const refuses = (name: string, mutate: (p: any) => void, rule: string) => {
    it(name, () => {
      const p = reseal(clone(build()));
      mutate(p);
      reseal(p); // prove the RULE, not the digest
      const v = verifyPlan(p, EXPECTED) as string[];
      expect(v.length, "should have refused").toBeGreaterThan(0);
      expect(v.join(" | ").toLowerCase()).toContain(rule);
    });
  };

  refuses("target studio differs from configuration",
    (p) => { p.body.target.studio_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"; },
    "differs from the configured target");
  refuses("primary key not derivable under the namespace",
    (p) => { p.body.entities.clients[0].id = deriveSyntheticId(TARGET, "client", 99999); },
    "not re-derivable");
  refuses("primary key is a v4 uuid",
    (p) => { p.body.entities.clients[0].id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"; },
    "version-8 synthetic uuid");
  refuses("email populated", (p) => { p.body.entities.clients[0].email = "x@example.org"; },
    "email must be null");
  refuses("phone populated", (p) => { p.body.entities.clients[0].phone = "+16475551234"; },
    "phone must be null");
  refuses("address populated", (p) => { p.body.entities.clients[0].address = "1 Road"; },
    "address must be null");
  refuses("unknown writable entity", (p) => { p.body.entities.payments = []; },
    "unknown writable entity");
  refuses("unknown writable column",
    (p) => { p.body.entities.clients[0].stripe_customer_id = "cus_1"; },
    "unknown writable column");
  refuses("row-count ceiling exceeded", (p) => {
    const r = p.body.entities.clients[0];
    p.body.entities.clients = Array.from({ length: CEILINGS.perEntity + 1 }, () => ({ ...r }));
    p.body.expected_counts.clients = CEILINGS.perEntity + 1;
  }, "ceiling");
  refuses("foreign studio on a row",
    (p) => { p.body.entities.clients[0].studio_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"; },
    "does not match the plan target");
  refuses("client_id outside the plan",
    (p) => { p.body.entities.appointments[0].client_id = deriveSyntheticId(TARGET, "client", 4000); },
    "outside this plan");
  refuses("appointment_id outside the plan",
    (p) => { p.body.entities.sessions[0].appointment_id = deriveSyntheticId(TARGET, "appointment", 4000); },
    "outside this plan");
  refuses("session_id outside the plan",
    (p) => { p.body.entities.session_blocks[0].session_id = deriveSyntheticId(TARGET, "session", 4000); },
    "outside this plan");
  refuses("practitioner from elsewhere",
    (p) => { p.body.entities.appointments[0].practitioner_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"; },
    "configured target practitioner");
  refuses("service from elsewhere",
    (p) => { p.body.entities.appointments[0].service_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"; },
    "target studio's services");
  refuses("status outside the CHECK vocabulary",
    (p) => { p.body.entities.appointments[0].status = "pending"; }, "outside the allowed set");
  refuses("non-aggregate key in the source profile",
    (p) => { p.body.source_profile.client_names = 1; }, "non-aggregate key");
  refuses("safety assertion flipped",
    (p) => { p.body.safety_assertions.contact_fields_null = false; }, "must be true");
  refuses("unknown body key", (p) => { p.body.extra = 1; }, "unknown body key");
  refuses("namespace changed", (p) => { p.body.namespace.id = "other.namespace"; }, "namespace.id must be");

  it("refuses an unknown TOP-LEVEL key", () => {
    const p = reseal(clone(build()));
    p.extra_authority = true;
    const v = verifyPlan(p, EXPECTED) as string[];
    expect(v.join(" ")).toContain("unknown top-level key");
  });

  it("refuses a future schema version outright rather than interpreting it", () => {
    const p = reseal(clone(build()));
    p.schema_version = 2;
    const v = verifyPlan(p, EXPECTED) as string[];
    expect(v[0]).toContain("schema_version must be exactly 1");
    expect(v).toHaveLength(1); // stops reading — does not best-effort continue
  });

  it("refuses source == target", () => {
    const p = build();
    const v = verifyPlan(p, { ...EXPECTED, sourceStudioId: TARGET }) as string[];
    expect(v.join(" ")).toContain("IS the source studio");
  });

  it("detects accidental corruption via the digest", () => {
    const p = clone(build());
    p.body.entities.clients[0].name = "Corrupted";
    // deliberately NOT resealed
    expect((verifyPlan(p, EXPECTED) as string[]).join(" ")).toContain("integrity check failed");
  });
});

describe("reset selection", () => {
  it("accepts only re-derivable ids", () => {
    const good = {
      clients: [deriveSyntheticId(TARGET, "client", 0), deriveSyntheticId(TARGET, "client", 1)],
    };
    expect(verifyResetSelection(good, { targetStudioId: TARGET })).toEqual([]);
  });

  it("refuses the WHOLE request when one id is not derivable", () => {
    const bad = {
      clients: [deriveSyntheticId(TARGET, "client", 0), "3f2504e0-4f89-41d3-9a0c-0305e82c3301"],
    };
    const v = verifyResetSelection(bad, { targetStudioId: TARGET }) as string[];
    expect(v.length).toBeGreaterThan(0);
    expect(v.join(" ")).toContain("REFUSING the whole request");
  });

  it("refuses an id belonging to another studio", () => {
    const bad = { clients: [deriveSyntheticId(SOURCE, "client", 0)] };
    expect((verifyResetSelection(bad, { targetStudioId: TARGET }) as string[]).length).toBeGreaterThan(0);
  });

  it("refuses an unknown entity", () => {
    const v = verifyResetSelection({ payments: [] }, { targetStudioId: TARGET }) as string[];
    expect(v.join(" ")).toContain("unknown entity");
  });
});

describe("export writes a FILE and never a row", () => {
  it("the exporter module performs no database access at all", () => {
    const src = readFileSync(join(ROOT, "scripts/synthetic-mirror/export.mjs"), "utf8");
    for (const dml of [".upsert(", ".insert(", ".delete()", "insert into", "delete from"]) {
      expect(src.toLowerCase().includes(dml.toLowerCase()), dml).toBe(false);
    }
    expect(src).not.toMatch(/createClient|SERVICE_ROLE|pg\b/);
  });

  it("the CLI's only write is writeFileSync", () => {
    const cli = readFileSync(join(ROOT, "scripts/synthetic-mirror.mjs"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(cli).toContain("writeFileSync");
    for (const dml of [".upsert(", ".insert(", ".delete()", ".update("]) {
      expect(cli.includes(dml), dml).toBe(false);
    }
  });

  it("verifies BEFORE writing, so an unexecutable plan never reaches disk", () => {
    const cli = readFileSync(join(ROOT, "scripts/synthetic-mirror.mjs"), "utf8");
    const verifyAt = cli.indexOf("verifyPlan(doc");
    const writeAt = cli.indexOf("writeFileSync(outPath");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(verifyAt);
  });
});
