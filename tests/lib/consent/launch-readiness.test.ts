import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// F-CONSENT-GAP. Behavioural proof of the ONE launch-readiness rule.
//
// BEHAVIOURAL, NOT SOURCE-GREP. A source test can assert that the string
// "is_live" appears in the helper; it cannot prove that a DRAFT row fails to
// satisfy readiness. So the fake below holds a real row set and APPLIES the
// recorded `.eq()` filters to it. A row that should not count does not count
// because the query genuinely excluded it, not because the test asserted it
// away.
//
// THE HARNESS MUST DISTINGUISH QUERY ERROR FROM ZERO ROWS, or the fail-closed
// assertions are vacuous — they would pass against a helper that returned a
// bare boolean. `data` and `error` are therefore independent, and the error
// case sets exactly one of them.
//
// The negative control for this file: make the helper count drafts (drop the
// `status`/`is_live` filters) and the draft/archived cases below must go RED.

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  rows: [] as Row[],
  // Set to force a query error. Independent of `rows` on purpose.
  error: null as { code: string; message: string } | null,
  // Set to make client construction itself throw.
  constructThrows: false,
  filters: [] as Array<[string, unknown]>,
  tables: [] as string[],
  selects: [] as string[],
  limits: [] as number[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (h.constructThrows) throw new Error("no supabase env");
    return {
      from(table: string) {
        h.tables.push(table);
        const applied: Array<[string, unknown]> = [];
        let limit = Infinity;
        const q: Record<string, unknown> = {};
        const settle = () => {
          h.filters.push(...applied);
          if (h.error) return { data: null, error: h.error };
          // Real filtering: every recorded equality must hold on the row.
          const matched = h.rows.filter((row) =>
            applied.every(([col, val]) => row[col] === val),
          );
          return { data: matched.slice(0, limit), error: null };
        };
        q.select = (cols: string) => {
          h.selects.push(cols);
          return q;
        };
        q.eq = (col: string, val: unknown) => {
          applied.push([col, val]);
          return q;
        };
        q.limit = (n: number) => {
          h.limits.push(n);
          limit = n;
          return q;
        };
        q.then = (resolve: (v: unknown) => unknown) => resolve(settle());
        return q;
      },
    };
  },
}));

const {
  getTreatmentConsentReadiness,
  LAUNCH_TREATMENT_CONSENT_FORM_TYPE,
  CONSENT_SETTINGS_HREF,
} = await import("@/lib/consent/launch-readiness");
const { INTAKE_CONSENT_COLLECTED_FORM_TYPES } = await import(
  "@/lib/intake/consent-forms"
);

const STUDIO = "studio-a";
const OTHER_STUDIO = "studio-b";

/** A row that DOES satisfy readiness, unless an override breaks it. */
function template(over: Row = {}): Row {
  return {
    id: "tpl-1",
    studio_id: STUDIO,
    form_type: "treatment_consent",
    status: "active",
    is_live: true,
    ...over,
  };
}

beforeEach(() => {
  h.rows = [];
  h.error = null;
  h.constructThrows = false;
  h.filters = [];
  h.tables = [];
  h.selects = [];
  h.limits = [];
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("getTreatmentConsentReadiness — the qualifying rule", () => {
  it("CASE 1: zero live consent templates is a KNOWN not-ready", async () => {
    h.rows = [];
    await expect(getTreatmentConsentReadiness(STUDIO)).resolves.toEqual({
      ok: true,
      ready: false,
    });
  });

  it("CASE 2: one live treatment consent is READY", async () => {
    h.rows = [template()];
    await expect(getTreatmentConsentReadiness(STUDIO)).resolves.toEqual({
      ok: true,
      ready: true,
    });
  });

  it("CASE 3a: a DRAFT treatment consent does not satisfy readiness", async () => {
    // is_live=false is forced too: migration 0072's CHECK makes a live draft
    // unrepresentable, so a draft row that claimed is_live=true would be
    // testing a state the database cannot hold.
    h.rows = [template({ status: "draft", is_live: false })];
    await expect(getTreatmentConsentReadiness(STUDIO)).resolves.toEqual({
      ok: true,
      ready: false,
    });
  });

  it("CASE 3b: an ARCHIVED treatment consent does not satisfy readiness", async () => {
    h.rows = [template({ status: "archived", is_live: false })];
    await expect(getTreatmentConsentReadiness(STUDIO)).resolves.toEqual({
      ok: true,
      ready: false,
    });
  });

  it("CASE 3c: ACTIVE but NOT LIVE does not satisfy readiness", async () => {
    // The state the whole is_live column exists to express (PR #167): ready to
    // use, deliberately not client-visible. It is not launch evidence.
    h.rows = [template({ status: "active", is_live: false })];
    await expect(getTreatmentConsentReadiness(STUDIO)).resolves.toEqual({
      ok: true,
      ready: false,
    });
  });

  it("CASE 4: another studio's live treatment consent does not satisfy readiness", async () => {
    h.rows = [template({ studio_id: OTHER_STUDIO })];
    await expect(getTreatmentConsentReadiness(STUDIO)).resolves.toEqual({
      ok: true,
      ready: false,
    });
  });

  it("a live PHOTO / CARD / GENERAL / POLICY form does not satisfy treatment consent", async () => {
    for (const formType of [
      "photo_consent",
      "card_authorization",
      "general",
      "policy_acknowledgement",
    ]) {
      h.rows = [template({ form_type: formType })];
      await expect(getTreatmentConsentReadiness(STUDIO)).resolves.toEqual({
        ok: true,
        ready: false,
      });
    }
  });

  it("a disqualified row alongside a qualifying one still reads READY", async () => {
    // Proves the rule is existential over the qualifying set, not a property of
    // the first row returned.
    h.rows = [
      template({ id: "draft", status: "draft", is_live: false }),
      template({ id: "other", studio_id: OTHER_STUDIO }),
      template({ id: "good" }),
    ];
    await expect(getTreatmentConsentReadiness(STUDIO)).resolves.toEqual({
      ok: true,
      ready: true,
    });
  });
});

describe("getTreatmentConsentReadiness — what it asks the database", () => {
  it("queries consent_form_templates with all four scoping filters", async () => {
    h.rows = [template()];
    await getTreatmentConsentReadiness(STUDIO);
    expect(h.tables).toEqual(["consent_form_templates"]);
    expect(h.filters).toEqual(
      expect.arrayContaining([
        ["studio_id", STUDIO],
        ["form_type", "treatment_consent"],
        ["status", "active"],
        ["is_live", true],
      ]),
    );
    // Exactly four: an extra filter would narrow readiness in a way no caller
    // documented, a missing one would widen it.
    expect(h.filters).toHaveLength(4);
  });

  it("is an existence question: projects id only, bounded to one row", async () => {
    h.rows = [template()];
    await getTreatmentConsentReadiness(STUDIO);
    // No template body is ever loaded to answer "is one live?".
    expect(h.selects).toEqual(["id"]);
    expect(h.selects.join()).not.toContain("body");
    expect(h.limits).toEqual([1]);
  });

  it("issues exactly ONE statement per call (no N+1)", async () => {
    h.rows = [template()];
    await getTreatmentConsentReadiness(STUDIO);
    expect(h.tables).toHaveLength(1);
  });
});

describe("getTreatmentConsentReadiness — unknown is neither ready nor not-ready", () => {
  it("a query error returns { ok: false }, never a boolean readiness", async () => {
    h.rows = [template()];
    h.error = { code: "42501", message: "permission denied" };
    const out = await getTreatmentConsentReadiness(STUDIO);
    expect(out).toEqual({ ok: false });
    expect(out).not.toHaveProperty("ready");
  });

  it("a thrown client construction returns { ok: false }, and does not escape", async () => {
    h.constructThrows = true;
    await expect(getTreatmentConsentReadiness(STUDIO)).resolves.toEqual({
      ok: false,
    });
  });

  it("failure logging is bounded to code + message, with no studio id", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.error = { code: "42501", message: "permission denied" };
    await getTreatmentConsentReadiness(STUDIO);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("treatment_consent_readiness_failed");
    expect(line).not.toContain(STUDIO);
  });
});

describe("the required form type is one the intake actually collects", () => {
  it("treatment_consent is in INTAKE_CONSENT_COLLECTED_FORM_TYPES", () => {
    // The coupling that matters, asserted rather than imported. If the intake
    // ever stopped collecting treatment consent, "ready" would stop meaning
    // "the intake presents a consent form" and this test is what notices.
    expect([...INTAKE_CONSENT_COLLECTED_FORM_TYPES]).toContain(
      LAUNCH_TREATMENT_CONSENT_FORM_TYPE,
    );
  });

  it("the helper pins the type literally rather than importing the intake set", () => {
    // Deliberate: widening INTAKE_CONSENT_COLLECTED_FORM_TYPES (a product
    // decision, per its own header) must not silently let a photo consent
    // satisfy TREATMENT consent readiness.
    const src = readFileSync(
      join(process.cwd(), "lib/consent/launch-readiness.ts"),
      "utf8",
    );
    // The header NAMES that constant to explain why it is not imported, so the
    // assertion is about the import, not the word.
    expect(src).not.toMatch(/^\s*import[^;]*intake\/consent-forms/m);
    expect(LAUNCH_TREATMENT_CONSENT_FORM_TYPE).toBe("treatment_consent");
  });
});

describe("the settings route it sends an owner to", () => {
  it("is the real consent settings route, and that page exists", () => {
    expect(CONSENT_SETTINGS_HREF).toBe("/settings/consent");
    // A dead link is the failure mode a hard-coded href invites. The route is
    // a file: assert the file.
    expect(() =>
      readFileSync(
        join(process.cwd(), "app/(app)/settings/consent/page.tsx"),
        "utf8",
      ),
    ).not.toThrow();
  });
});
