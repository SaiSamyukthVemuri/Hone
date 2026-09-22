import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// EMERG-PORTAL-REBOOK-01 — the identity boundary, pinned at the source.
//
// The whole unit rests on one property: the returning client's identity comes
// from the portal session and from NOWHERE ELSE. The dormant unauthenticated
// path in app/book/[slug]/actions.ts binds `client_type=existing` by matching a
// TYPED email against an active client, which is an impersonation surface. This
// action must never grow that shape.
//
// A browser assertion cannot see this: an action that quietly read
// formData.get("email") would render identically right up until someone used
// it. So it is checked in the source, and every check below carries a NEGATIVE
// CONTROL proving it fires on the shape it forbids — a "does not contain" rule
// that matches nothing passes on an empty file.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const ACTION_REL = "app/portal/rebook-actions.ts";
const RAW = read(ACTION_REL);

// LINE comments are stripped BEFORE block comments: a `//` line containing `/*`
// would otherwise leave the block stripper eating real code to the next `*/`
// and make every assertion below vacuously true. The action's own prose names
// `email`, `clientId` and the dormant path when explaining what it refuses to
// do, so prose must not satisfy — or trip — a source rule.
const codeOnly = (source: string) =>
  source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const CODE = codeOnly(RAW);

describe("the comment stripper itself", () => {
  it("keeps code and drops prose", () => {
    expect(CODE).toContain("export async function bookAnotherAppointmentAction");
    // This sentence exists only in a comment.
    expect(RAW).toContain("It never supplies");
    expect(CODE).not.toContain("It never supplies");
  });
});

describe("identity comes from the session, never from the form", () => {
  /** Every shape that would let a caller name WHO they are. */
  const SUBMITTED_IDENTITY = [
    /formData\.get\(\s*["']email["']\s*\)/,
    /formData\.get\(\s*["']clientId["']\s*\)/,
    /formData\.get\(\s*["']client_id["']\s*\)/,
    /formData\.get\(\s*["']studioId["']\s*\)/,
    /formData\.get\(\s*["']studio_id["']\s*\)/,
    /formData\.get\(\s*["']name["']\s*\)/,
    /formData\.get\(\s*["']phone["']\s*\)/,
    /formData\.get\(\s*["']clientType["']\s*\)/,
    /formData\.get\(\s*["']client_type["']\s*\)/,
  ];

  for (const shape of SUBMITTED_IDENTITY) {
    it(`never reads ${String(shape)}`, () => {
      expect(CODE).not.toMatch(shape);
    });
  }

  it("resolves the session before it reads anything submitted", () => {
    const session = CODE.indexOf("getCurrentPortalSession");
    const firstForm = CODE.indexOf("formData.get");
    expect(session).toBeGreaterThan(-1);
    expect(firstForm).toBeGreaterThan(-1);
    expect(
      session,
      "the session must be resolved before any submitted value is read, so a " +
        "refusal cannot depend on submitted data",
    ).toBeLessThan(firstForm);
  });

  it("passes the SESSION's client id to the commit, not a submitted one", () => {
    // p_client_id must be bound to the destructured session value.
    expect(CODE).toMatch(/p_client_id:\s*clientId\b/);
    expect(CODE).toMatch(/p_studio_id:\s*studio\.id\b/);
    // and `clientId` must originate in the session resolver, not a form read.
    expect(CODE).toMatch(/clientId:\s*session\.clientId/);
  });

  it("the form supplies ONLY choices", () => {
    const reads = [...CODE.matchAll(/formData\.get\(\s*["']([a-zA-Z_]+)["']\s*\)/g)].map(
      (m) => m[1],
    );
    expect(reads.length).toBeGreaterThan(0);
    expect([...new Set(reads)].sort()).toEqual(["serviceId", "startsAt"]);
  });

  describe("the guards are not vacuous", () => {
    // Without these, every `not.toMatch` above could pass because the patterns
    // match nothing at all.
    it("SUBMITTED_IDENTITY fires on the shape it forbids", () => {
      const forged = `const email = formData.get("email");
const clientId = formData.get("clientId");`;
      const fired = SUBMITTED_IDENTITY.filter((p) => p.test(forged));
      expect(fired.length).toBeGreaterThanOrEqual(2);
    });

    it("none of them fires on the shipped action", () => {
      // Strict AND satisfiable, not merely strict.
      for (const shape of SUBMITTED_IDENTITY) {
        expect(CODE, String(shape)).not.toMatch(shape);
      }
    });
  });
});

describe("the commit goes through the locked command, not a raw insert", () => {
  it("calls create_public_appointment", () => {
    expect(CODE).toMatch(/\.rpc\(\s*\n?\s*["']create_public_appointment["']/);
  });

  it("never inserts into appointments directly", () => {
    // The command writes the MANDATORY appointment_audit row in the same
    // transaction. A direct insert here would reintroduce the exact defect
    // migration 0170 exists to close.
    expect(CODE).not.toMatch(/from\(\s*["']appointments["']\s*\)[\s\S]{0,200}\.insert\(/);
  });

  it("requests no duration, status or override", () => {
    for (const forbidden of [/p_duration/, /p_status/, /p_end/, /p_override/, /p_practitioner_id/]) {
      expect(CODE, String(forbidden)).not.toMatch(forbidden);
    }
  });
});

describe("it does not reopen the unauthenticated existing-client path", () => {
  it("imports nothing from the public booking action", () => {
    expect(CODE).not.toMatch(/from\s+["']@\/app\/book\//);
  });

  it("never sends client_type", () => {
    expect(CODE).not.toMatch(/client_type/);
  });

  it("adds no migration dependency of its own", () => {
    // The command already accepted p_client_id. The emergency needed a caller,
    // not new schema — and a source rule is what keeps a later edit honest.
    expect(CODE).not.toMatch(/create_portal_appointment|p_portal/);
  });
});

describe("refusals do not become an enumeration channel", () => {
  it("never echoes the command's refusal vocabulary to the client", () => {
    // These name a tenancy or eligibility fact. `invalid_time` and
    // `not_a_public_slot` are compared against, but the RETURNED string is one
    // of the module's own constants.
    for (const code of ["invalid_client", "invalid_service", "studio_not_found", "not_eligible"]) {
      expect(CODE, code).not.toMatch(new RegExp(`error:\\s*["'\`][^"'\`]*${code}`));
    }
  });

  it("a failed studio read is refused, not treated as a missing studio", () => {
    expect(CODE).toMatch(/if\s*\(error\s*\|\|\s*!data\)/);
  });
});
