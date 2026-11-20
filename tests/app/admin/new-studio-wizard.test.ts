import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// PR #254: internal New Studio Wizard. Source-pins the create action's own
// isAdmin re-check and the invariants that must not regress: NO direct
// practitioner insert, no orphan studio, NO payment/Stripe surface, and no
// public studio-creation route. The route gates (middleware, layout, page) are
// proven by tests/security/sec-002-admin-route-requests.test.ts; end-to-end
// behaviour by tests/db/new-studio-wizard.db.test.ts and
// e2e/new-studio-wizard.spec.ts.

const ROOT = path.resolve(__dirname, "../../..");
function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

const ACTION = read("app/admin/studios/new/actions.ts");
const ACTION_CODE = codeOnly(ACTION);

describe("operator-only access (reuses the existing isAdmin gate)", () => {
  it("the create action re-checks isAdmin server-side BEFORE any write", () => {
    expect(ACTION_CODE).toMatch(/if \(!user \|\| !isAdmin\(user\.email\)\)/);
    expect(ACTION_CODE).toMatch(/throw new Error\("Not authorized\."\)/);
    // The isAdmin check must come before the service-role client is created.
    const gateIdx = ACTION_CODE.indexOf("isAdmin(user.email)");
    const adminIdx = ACTION_CODE.indexOf("createAdminClient()");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(adminIdx).toBeGreaterThan(gateIdx);
  });
});

describe("the service-role writes stay inside their boundary", () => {
  it("NEVER inserts a practitioners row directly (owner is provisioned at sign-in)", () => {
    expect(ACTION_CODE).not.toMatch(/\.from\("practitioners"\)/);
  });

  it("compensating-deletes the studio if the invitation insert fails (no orphan)", () => {
    expect(ACTION_CODE).toMatch(/if \(inviteErr\)/);
    expect(ACTION_CODE).toMatch(/\.from\("studios"\)\s*\n?\s*\.delete\(\)/);
  });

  it("touches NO payment / Stripe / fee / livemode columns", () => {
    expect(ACTION_CODE).not.toMatch(
      /fee_cents|stripe|livemode|payment|paymentIntents|require_card/i,
    );
  });
});

describe("invite-only posture is not weakened", () => {
  it("introduces NO public self-serve studio-creation route", () => {
    // The wizard lives ONLY under app/admin (operator-gated). No public route.
    expect(existsSync(path.join(ROOT, "app/studios"))).toBe(false);
    expect(existsSync(path.join(ROOT, "app/(auth)/signup"))).toBe(false);
    expect(existsSync(path.join(ROOT, "app/signup"))).toBe(false);
    expect(existsSync(path.join(ROOT, "app/admin/studios/new/page.tsx"))).toBe(true);
  });
});

// ===========================================================================
// 0205 -- THE WIZARD INHERITS THE DATABASE DEFAULT AND IMPLEMENTS NOTHING.
//
// A new studio must begin at new-client admission = OPEN with its authority
// already initialized. 0205 does that with a column default on
// `studios.new_client_admission_mode_set_at`, deliberately at the DATABASE
// layer rather than here, so that every future creation path -- a second admin
// surface, a self-serve signup, a restore, a test fixture -- inherits the same
// semantics without re-implementing them.
//
// THIS BLOCK IS THE "DO NOT DUPLICATE IT" HALF. A second application-only
// implementation would be the bug class the default exists to remove: two
// writers of the same invariant, drifting apart, with the database no longer the
// authority on what a new studio is. The wizard must therefore name NONE of the
// three admission fields.
//
// The default's actual effect on an insert is proved against a real database in
// tests/db/new-studio-admission-default.db.test.ts; nothing here can prove it,
// because an absence in source is not a value in a row.
// ===========================================================================
describe("new-client admission is initialized by the DATABASE, not by the wizard", () => {
  it("names none of the three admission fields in its studio insert", () => {
    for (const field of [
      "new_client_admission_mode",
      "new_client_admission_mode_set_at",
      "new_client_admission_mode_set_by",
    ]) {
      expect(
        ACTION_CODE,
        `the wizard must inherit ${field} from the 0205 column default, not set it`,
      ).not.toContain(field);
    }
  });

  it("does not call the admission command either", () => {
    // Calling `set_new_client_admission_mode` at creation would also be a second
    // implementation -- and it could not work: the command resolves an ACTIVE
    // OWNER practitioner from auth.uid(), and no owner practitioner exists yet
    // (the test above pins that the wizard never inserts one; the membership is
    // created or reconciled later, at authenticated sign-in or explicit
    // invitation acceptance, through 0141's reconciliation path - NOT by
    // handle_new_user, which 0141 made a NO-OP).
    expect(ACTION_CODE).not.toContain("set_new_client_admission_mode");
  });

  it("still inserts the studio, so the claim above is about ABSENCE not emptiness", () => {
    // Non-vacuity. If the insert were ever removed or renamed, every "does not
    // contain" assertion above would pass for the wrong reason.
    expect(ACTION_CODE).toMatch(/\.from\("studios"\)\s*\n?\s*\.insert\(/);
  });
});
