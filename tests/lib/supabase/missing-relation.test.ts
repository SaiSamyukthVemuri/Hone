import { describe, expect, it } from "vitest";
import { isMissingRelationError } from "@/lib/supabase/missing-relation";

// The error payloads below are VERBATIM captures from this repository's own
// local Supabase stack (PostgREST via kong on 127.0.0.1:54321), not invented
// shapes. They were produced by:
//   * querying client_budget_context while the table did not exist  -> PGRST205
//   * creating a table, letting the schema cache pick it up, dropping it, then
//     querying before the cache reloaded                            -> 42P01
//   * querying client_clinical_notes as anon, which holds no grants -> 42501
//
// If PostgREST ever changes these shapes, these tests are the tripwire — the
// classifier failing OPEN (tolerating too much) is the dangerous direction, so
// the negative cases matter more than the positive ones.

const TABLE = "client_budget_context";

const MISSING_FROM_CACHE = {
  code: "PGRST205",
  details: null,
  hint: null,
  message: `Could not find the table 'public.${TABLE}' in the schema cache`,
};

const STALE_CACHE_UNDEFINED_TABLE = {
  code: "42P01",
  details: null,
  hint: null,
  message: `relation "public.${TABLE}" does not exist`,
};

const PERMISSION_DENIED = {
  code: "42501",
  details: null,
  hint: `Grant the required privileges to the current role with: GRANT SELECT ON public.${TABLE} TO anon;`,
  message: `permission denied for table ${TABLE}`,
};

describe("isMissingRelationError: the two proven skew forms", () => {
  it("matches PGRST205 naming this relation (forward skew: migration not applied)", () => {
    expect(isMissingRelationError(MISSING_FROM_CACHE, TABLE)).toBe(true);
  });

  it("matches 42P01 naming this relation (stale cache after a rollback)", () => {
    expect(isMissingRelationError(STALE_CACHE_UNDEFINED_TABLE, TABLE)).toBe(
      true,
    );
  });
});

describe("isMissingRelationError: everything else stays FATAL", () => {
  it("does NOT match a permission denial — the most dangerous false positive", () => {
    // Tolerating this would turn an authorization failure into "no data",
    // which reads as an empty record and can then be overwritten with blanks.
    expect(isMissingRelationError(PERMISSION_DENIED, TABLE)).toBe(false);
  });

  it("does NOT match the same missing-table codes for a DIFFERENT relation", () => {
    expect(
      isMissingRelationError(
        {
          code: "PGRST205",
          message: "Could not find the table 'public.clients' in the schema cache",
        },
        TABLE,
      ),
    ).toBe(false);
    expect(
      isMissingRelationError(
        { code: "42P01", message: 'relation "public.treatment_plans" does not exist' },
        TABLE,
      ),
    ).toBe(false);
  });

  it("does NOT match a relation whose name merely EXTENDS this one", () => {
    // A missing client_budget_context_archive is not a missing
    // client_budget_context.
    expect(
      isMissingRelationError(
        {
          code: "PGRST205",
          message: `Could not find the table 'public.${TABLE}_archive' in the schema cache`,
        },
        TABLE,
      ),
    ).toBe(false);
    expect(
      isMissingRelationError(
        { code: "42P01", message: `relation "public.${TABLE}_v2" does not exist` },
        TABLE,
      ),
    ).toBe(false);
  });

  it("does NOT match auth, timeout or request errors", () => {
    for (const err of [
      { code: "PGRST301", message: "JWT expired" },
      { code: "57014", message: "canceling statement due to statement timeout" },
      { code: "PGRST103", message: "Requested range not satisfiable" },
      { code: "PGRST116", message: "multiple (or no) rows returned" },
      { code: "23505", message: "duplicate key value violates unique constraint" },
    ]) {
      expect(isMissingRelationError(err, TABLE)).toBe(false);
    }
  });

  it("does NOT match the paginator's own partial-read refusal", () => {
    // fetchAllRows refuses rather than returning a capped set, and that
    // refusal carries no PostgREST code. Swallowing it would reintroduce the
    // silent truncation the paginator exists to prevent.
    expect(
      isMissingRelationError(
        {
          message:
            "Export read exceeded 500 pages (500000 rows); refusing to return a partial table.",
        },
        TABLE,
      ),
    ).toBe(false);
  });

  it("does NOT match anything without a usable code or message", () => {
    for (const err of [
      null,
      undefined,
      "PGRST205",
      42,
      {},
      { code: "PGRST205" },
      { message: `relation "public.${TABLE}" does not exist` },
      { code: "PGRST205", message: "" },
      { code: 42101, message: `relation "public.${TABLE}" does not exist` },
      new Error(`relation "public.${TABLE}" does not exist`),
    ]) {
      expect(isMissingRelationError(err, TABLE)).toBe(false);
    }
  });

  it("does NOT match the right message under the WRONG code", () => {
    // The code is the primary gate; a message alone must never be enough.
    expect(
      isMissingRelationError(
        { code: "42501", message: `relation "public.${TABLE}" does not exist` },
        TABLE,
      ),
    ).toBe(false);
  });

  it("treats a relation name with regex metacharacters literally", () => {
    expect(
      isMissingRelationError(
        { code: "42P01", message: 'relation "public.axbxc" does not exist' },
        "a.b.c",
      ),
    ).toBe(false);
  });
});
