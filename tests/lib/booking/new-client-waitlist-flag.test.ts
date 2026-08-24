import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isNewClientWaitlistDurableEnabled,
  isNewClientWaitlistEnabled,
  NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV,
  NEW_CLIENT_WAITLIST_SLUGS_ENV,
  validateWaitlistSubmission,
  WAITLIST_NAME_MAX,
  WAITLIST_PHONE_MAX,
} from "@/lib/booking/new-client-waitlist";

// ===========================================================================
// THE KILL SWITCH
// ===========================================================================
// The whole release rests on this predicate. Wrong in the OFF direction and a
// studio silently keeps taking new clients it cannot serve; wrong in the ON
// direction and an unrelated studio's public booking page is replaced by a
// waitlist. Both are production incidents, so every boundary is pinned.

const ORIGINAL = process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
function setEnv(value: string | undefined) {
  if (value === undefined) delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
  else process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = value;
}
beforeEach(() => setEnv(undefined));
afterEach(() => setEnv(ORIGINAL));

describe("isNewClientWaitlistEnabled", () => {
  it("is OFF when unset", () => {
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(false);
  });

  it("is OFF for empty, whitespace-only, and separator-only values", () => {
    for (const v of ["", "   ", " , ,, "]) {
      setEnv(v);
      expect(isNewClientWaitlistEnabled("willow-electrolysis"), v).toBe(false);
    }
  });

  it("is ON for the exact configured slug", () => {
    setEnv("willow-electrolysis");
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(true);
  });

  it("is OFF for an unrelated studio while another is enabled", () => {
    setEnv("willow-electrolysis");
    expect(isNewClientWaitlistEnabled("some-other-studio")).toBe(false);
  });

  it("handles a multi-slug list, including padded entries", () => {
    setEnv(" willow-electrolysis , second-studio,third-studio ");
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(true);
    expect(isNewClientWaitlistEnabled("second-studio")).toBe(true);
    expect(isNewClientWaitlistEnabled("third-studio")).toBe(true);
    expect(isNewClientWaitlistEnabled("fourth-studio")).toBe(false);
  });

  // The catastrophic one: enabling a studio must not silence a DIFFERENT
  // studio whose slug contains, extends, or is contained by it.
  it("NEVER matches on substring, prefix or suffix", () => {
    setEnv("willow-electrolysis");
    for (const slug of [
      "willow",
      "electrolysis",
      "willow-electrolysis-archive",
      "new-willow-electrolysis",
      "illow-electrolysi",
    ]) {
      expect(isNewClientWaitlistEnabled(slug), slug).toBe(false);
    }
  });

  it("normalizes case and whitespace on BOTH sides", () => {
    setEnv("Willow-Electrolysis");
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(true);
    expect(isNewClientWaitlistEnabled("  WILLOW-ELECTROLYSIS  ")).toBe(true);
  });

  it("is OFF for an empty, blank or nullish slug even with a populated list", () => {
    setEnv("willow-electrolysis,");
    expect(isNewClientWaitlistEnabled("")).toBe(false);
    expect(isNewClientWaitlistEnabled("   ")).toBe(false);
    expect(isNewClientWaitlistEnabled(null)).toBe(false);
    expect(isNewClientWaitlistEnabled(undefined)).toBe(false);
  });

  it("re-reads the env every call, so the kill switch needs no restart", () => {
    setEnv("willow-electrolysis");
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(true);
    setEnv("");
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(false);
  });
});

describe("validateWaitlistSubmission", () => {
  it("accepts a full submission and normalizes it", () => {
    expect(
      validateWaitlistSubmission({
        name: "  Ada Lovelace  ",
        email: "  ADA@Example.COM ",
        phone: "  +1 555 0100  ",
      }),
    ).toEqual({
      ok: true,
      value: { name: "Ada Lovelace", email: "ada@example.com", phone: "+1 555 0100" },
    });
  });

  it("treats an omitted or whitespace-only phone as null", () => {
    for (const phone of [null, "   "]) {
      const r = validateWaitlistSubmission({ name: "Ada", email: "a@b.co", phone });
      expect(r.ok && r.value.phone).toBeNull();
    }
  });

  it("refuses a blank or whitespace-only name", () => {
    expect(validateWaitlistSubmission({ name: "", email: "a@b.co", phone: null }).ok).toBe(false);
    expect(validateWaitlistSubmission({ name: "  ", email: "a@b.co", phone: null }).ok).toBe(false);
  });

  it("bounds name, email and phone, accepting the exact ceiling", () => {
    expect(
      validateWaitlistSubmission({
        name: "a".repeat(WAITLIST_NAME_MAX + 1),
        email: "a@b.co",
        phone: null,
      }).ok,
    ).toBe(false);
    expect(
      validateWaitlistSubmission({
        name: "Ada",
        email: `${"a".repeat(250)}@example.com`,
        phone: null,
      }).ok,
    ).toBe(false);
    expect(
      validateWaitlistSubmission({
        name: "Ada",
        email: "a@b.co",
        phone: "9".repeat(WAITLIST_PHONE_MAX + 1),
      }).ok,
    ).toBe(false);
    expect(
      validateWaitlistSubmission({
        name: "a".repeat(WAITLIST_NAME_MAX),
        email: "a@b.co",
        phone: "9".repeat(WAITLIST_PHONE_MAX),
      }).ok,
    ).toBe(true);
  });

  it("refuses malformed email addresses", () => {
    for (const email of ["", "   ", "nope", "no@domain", "a b@example.com", "@example.com", "a@"]) {
      expect(
        validateWaitlistSubmission({ name: "Ada", email, phone: null }).ok,
        JSON.stringify(email),
      ).toBe(false);
    }
  });

  it("never echoes the submitted value back in a refusal message", () => {
    const r = validateWaitlistSubmission({
      name: "Ada",
      email: "pii_canary_92837 at example.com",
      phone: null,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).not.toContain("pii_canary_92837");
  });
});

// ===========================================================================
// WAIT-02B STAGE B — THE ACTIVATION CONTROL
// ===========================================================================
//
// Stage A held the durable prospect record shut with a deploy-time prohibition
// on this variable naming ANY studio. Stage B1 ships the public disclosure and
// replaces that with a shape check, which makes THIS predicate the whole of
// activation. Being right in both directions now decides whether a real
// person's details are committed to a table.
//
// Its semantics are deliberately identical to the gate above (same parser, same
// exact-match membership), so the boundaries are re-pinned here rather than
// assumed to be shared: they are shared TODAY, and this is what would go red if
// the durable path ever grew its own looser copy.

const DURABLE_ORIGINAL = process.env[NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV];
function setDurableEnv(value: string | undefined) {
  if (value === undefined) delete process.env[NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV];
  else process.env[NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV] = value;
}

describe("isNewClientWaitlistDurableEnabled (Stage-B activation)", () => {
  beforeEach(() => setDurableEnv(undefined));
  afterEach(() => setDurableEnv(DURABLE_ORIGINAL));

  it("UNSET enables zero studios — the state this release ships to production", () => {
    for (const slug of ["willow-electrolysis", "second-studio", "anything-at-all"]) {
      expect(isNewClientWaitlistDurableEnabled(slug), slug).toBe(false);
    }
  });

  it("empty, whitespace-only and comma-only all enable zero studios", () => {
    for (const v of ["", "   ", ",,,", " , ,  , "]) {
      setDurableEnv(v);
      expect(isNewClientWaitlistDurableEnabled("willow-electrolysis"), v).toBe(false);
    }
  });

  it("enables ONLY the explicitly named slug; every other studio stays dark", () => {
    setDurableEnv("willow-electrolysis");
    expect(isNewClientWaitlistDurableEnabled("willow-electrolysis")).toBe(true);
    for (const other of [
      "second-studio",
      "willow",
      "electrolysis",
      "willow-electrolysis-archive",
      "new-willow-electrolysis",
    ]) {
      expect(isNewClientWaitlistDurableEnabled(other), other).toBe(false);
    }
  });

  // THE PROPERTY THE ACTIVATION GUARD EXISTS FOR. No value is interpreted as
  // "every studio", because the runtime interprets no values at all — it asks
  // set membership. A wildcard is therefore inert, not expansive.
  it("has NO wildcard: no value turns on a studio that was not typed out", () => {
    for (const wildcard of ["*", "%", "all", "any", "true", "1", ".*", "on", "enabled"]) {
      setDurableEnv(wildcard);
      for (const slug of ["willow-electrolysis", "second-studio", "e2e-waitlist-p0"]) {
        expect(
          isNewClientWaitlistDurableEnabled(slug),
          `${wildcard} must not enable ${slug}`,
        ).toBe(false);
      }
    }
  });

  it("a multi-studio list enables each named studio and nothing else", () => {
    setDurableEnv(" willow-electrolysis , second-studio ");
    expect(isNewClientWaitlistDurableEnabled("willow-electrolysis")).toBe(true);
    expect(isNewClientWaitlistDurableEnabled("second-studio")).toBe(true);
    expect(isNewClientWaitlistDurableEnabled("third-studio")).toBe(false);
  });

  it("normalizes case and padding on both sides, exactly like the gate", () => {
    setDurableEnv("  Willow-Electrolysis  ");
    expect(isNewClientWaitlistDurableEnabled("willow-electrolysis")).toBe(true);
    expect(isNewClientWaitlistDurableEnabled("  WILLOW-ELECTROLYSIS ")).toBe(true);
  });

  it("is OFF for a blank or nullish slug even with a populated list", () => {
    setDurableEnv("willow-electrolysis");
    expect(isNewClientWaitlistDurableEnabled("")).toBe(false);
    expect(isNewClientWaitlistDurableEnabled("   ")).toBe(false);
    expect(isNewClientWaitlistDurableEnabled(null)).toBe(false);
    expect(isNewClientWaitlistDurableEnabled(undefined)).toBe(false);
  });

  it("re-reads the env every call, so deactivating needs no redeploy", () => {
    setDurableEnv("willow-electrolysis");
    expect(isNewClientWaitlistDurableEnabled("willow-electrolysis")).toBe(true);
    setDurableEnv("");
    expect(isNewClientWaitlistDurableEnabled("willow-electrolysis")).toBe(false);
  });

  // The two variables are independent SETS, and the durable one is subordinate:
  // the submit path only consults it after the gate has said yes. Listing a
  // studio here while its gate is off therefore enables nothing.
  it("is a separate variable from the admission gate", () => {
    expect(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV).not.toBe(NEW_CLIENT_WAITLIST_SLUGS_ENV);
    setDurableEnv("second-studio");
    setEnv("willow-electrolysis");
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(true);
    expect(isNewClientWaitlistDurableEnabled("willow-electrolysis")).toBe(false);
    expect(isNewClientWaitlistDurableEnabled("second-studio")).toBe(true);
    expect(isNewClientWaitlistEnabled("second-studio")).toBe(false);
  });
});

describe("the activation control has no second implementation", () => {
  // Source contract over CODE ONLY. Comments in this module legitimately quote
  // the very shapes being forbidden ("*", "all") while explaining why they are
  // inert, so a raw-text scan would fail on its own documentation.
  const CODE = readFileSync(
    path.resolve(__dirname, "../../../lib/booking/new-client-waitlist.ts"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("routes BOTH predicates through the one membership helper", () => {
    // One definition + exactly two call sites: the admission gate and the
    // durable activation. A third would be a second authority.
    expect([...CODE.matchAll(/slugIsListed\(/g)]).toHaveLength(3);
    expect(CODE).toMatch(/return parseWaitlistSlugs\(process\.env\[envVar\]\)\.has\(slug\)/);
  });

  it("reads the environment in exactly ONE place, through that helper", () => {
    expect([...CODE.matchAll(/process\.env/g)]).toHaveLength(1);
  });

  it("has no wildcard, catch-all, prefix-match or force-on branch", () => {
    // Scoped to the SLUG path — parse, membership, and both predicates. The
    // module's one regex (EMAIL_RE) validates a submitted ADDRESS and lives
    // outside this region; a whole-file scan could not tell the two apart.
    const start = CODE.indexOf("function parseWaitlistSlugs");
    const end = CODE.indexOf("export type WaitlistSubmission");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const slugPath = CODE.slice(start, end);

    // Membership is `.has(slug)` on a Set. Any of these would mean something
    // other than exact equality decides activation.
    expect(slugPath).toMatch(/\.has\(slug\)/);
    expect(slugPath).not.toMatch(/startsWith|endsWith|\.includes\(|\.test\(|RegExp/);
    expect(slugPath).not.toMatch(/"\*"|'\*'|wildcard/i);
    expect(CODE).not.toMatch(/SKIP_WAITLIST|WAITLIST_BYPASS|FORCE_DURABLE|DURABLE_ALL/i);
  });
});
