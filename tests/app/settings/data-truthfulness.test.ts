import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Product claims must not outrun the product (security review findings #6, #7,
// #8, and the #4 backup overclaim).
//
// These are deliberately SOURCE tests over a handful of DANGEROUS SEMANTIC
// STRINGS, not page snapshots. A snapshot breaks on every copy edit and teaches
// people to re-bless it; these fail only when a specific untrue claim comes
// back. Each one names the claim it forbids and why it was untrue.

const REPO = path.resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(path.join(REPO, p), "utf8");

const DATA_PAGE = read("app/(app)/settings/data/page.tsx");
const DATA_ACTIONS = read("app/(app)/settings/data/actions.ts");
const PRIVACY = read("app/privacy/page.tsx");
const TERMS = read("app/terms/page.tsx");

describe("#7 — data residency claims cannot contradict the Privacy Policy", () => {
  // The Privacy Policy states the database is Supabase on AWS US-East-1
  // (Northern Virginia). The settings page simultaneously said "Hone stores
  // this data in Canada" and "Data hosted in Canada". Both cannot be true.
  it("the Privacy Policy still names the real hosting region", () => {
    expect(PRIVACY).toMatch(/US-East-1/);
    expect(PRIVACY).toMatch(/United States/);
  });

  it("no active product surface claims data is hosted or stored in Canada", () => {
    for (const [name, src] of [
      ["settings/data/page.tsx", DATA_PAGE],
      ["settings/data/actions.ts", DATA_ACTIONS],
    ] as const) {
      expect(src, `${name} must not claim Canadian hosting`).not.toMatch(
        /hosted in Canada|stored in Canada|stores this data in Canada/i,
      );
    }
  });

  it("the data page points at the Privacy Policy for hosting instead of naming one country", () => {
    expect(DATA_PAGE).toMatch(/may process this data outside\s+Canada/);
    expect(DATA_PAGE).toMatch(/\/privacy/);
  });
});

describe("#6 — retention promises match current capability", () => {
  // Neither an automatic 30-day hard purge nor a 90-day backup purge is
  // implemented: there is no retention job anywhere in the tree, and
  // vercel.json registers no purge cron.
  it("the Privacy Policy does not promise a timed hard-delete or backup purge", () => {
    expect(PRIVACY).not.toMatch(/then hard-deleted from active systems/i);
    expect(PRIVACY).not.toMatch(/[Bb]ackups are purged within/i);
  });

  it("the Terms do not promise a timed backup purge either", () => {
    expect(TERMS).not.toMatch(/[Bb]ackups containing Your Data are purged within/i);
    expect(TERMS).not.toMatch(/we will delete Client Data within 30\s*\n?\s*days/i);
  });

  it("both documents say plainly that no automatic timed purge runs today", () => {
    // JSX wraps prose across lines, so match on whitespace rather than a
    // single-line phrase — otherwise a reflow silently disarms this guard.
    const noTimedPurge = /do not currently\s+operate an automatic timed purge/i;
    expect(PRIVACY).toMatch(noTimedPurge);
    expect(TERMS).toMatch(noTimedPurge);
  });

  it("archiving is distinguished from permanent erasure", () => {
    expect(PRIVACY).toMatch(/[Aa]rchiv/);
    expect(PRIVACY).toMatch(/not the same as permanent erasure/i);
  });

  it("legal / professional retention obligations are acknowledged", () => {
    expect(PRIVACY).toMatch(/record-retention obligation|required to\s*\n?\s*retain/i);
  });
});

describe("#8 — the Terms do not describe automated Hone subscription billing as live", () => {
  // Census at this baseline found ZERO Hone-to-studio subscription machinery:
  // no subscriptions.create, no stripe_subscription / subscription_id, no
  // entitlements, no dunning, no customer.subscription or
  // invoice.payment_failed handling. The only `checkout.sessions` reference is
  // a guard script that FORBIDS Stripe Checkout.
  it("no live subscription lifecycle is claimed", () => {
    expect(TERMS).not.toMatch(/Subscriptions are billed in advance/i);
    expect(TERMS).not.toMatch(
      /If your payment fails, we may suspend your account/i,
    );
  });

  it("the current commercial posture is stated instead", () => {
    expect(TERMS).toMatch(
      /no automated Hone subscription billing system at this time/i,
    );
    expect(TERMS).toMatch(/agreed directly with you as a\s*\n?\s*participating studio/i);
  });

  it("studio-to-client Stripe payments are explicitly NOT changed", () => {
    // Section 8 governs what the studio pays Hone. The separate product — what
    // the studio charges its own clients — must not be swept up by this edit.
    expect(TERMS).toMatch(/separate from the payments your studio takes from its own clients/i);
  });

  it("the subscription census assumption is still true", async () => {
    // If someone later builds real subscription billing, this test should fail
    // so the Terms get restored rather than left understating the product.
    const { execSync } = await import("node:child_process");
    const hits = execSync(
      `grep -rlE "subscriptions\\.create|stripe_subscription|customer\\.subscription|invoice\\.payment_failed" app lib || true`,
      { cwd: REPO, encoding: "utf8" },
    ).trim();
    expect(hits, "subscription machinery appeared; revisit Terms section 8").toBe("");
  });
});

describe("#4 — the export is not sold as a database backup", () => {
  it("the data page never calls the ZIP a backup", () => {
    expect(DATA_PAGE).not.toMatch(/use this as a backup/i);
    expect(DATA_PAGE).not.toMatch(/keep it\s*\n?\s*as a backup/i);
  });

  it("the data page says what it actually is", () => {
    expect(DATA_PAGE).toMatch(/portable copy of your supported studio records/i);
    expect(DATA_PAGE).toMatch(/not a transactional database backup/i);
  });

  it("the ZIP README says the same thing", () => {
    expect(DATA_ACTIONS).toMatch(/not a transactional database backup/i);
    expect(DATA_ACTIONS).not.toMatch(
      /This export contains all client records, sessions, entries/,
    );
  });

  it("the Included list names the sources that were added later", () => {
    // Record-keeping and clinical notes are exported but were missing from the
    // list, so the page under-described what the ZIP actually contains.
    expect(DATA_PAGE).toMatch(/Consultation notes/i);
    expect(DATA_PAGE).toMatch(/Record-keeping logs/i);
    expect(DATA_PAGE).toMatch(/Exposure-incident log/i);
    expect(DATA_PAGE).toMatch(/manifest\.json/);
  });
});

describe("export privilege posture is unchanged (E7, E8)", () => {
  it("E7 — the owner-only gate is still enforced", () => {
    expect(DATA_ACTIONS).toMatch(/practitioner\.role !== "owner"/);
    expect(DATA_ACTIONS).toMatch(/You do not have permission to export data\./);
  });

  it("E8 — the export never widens to a service-role / admin client", () => {
    for (const forbidden of [
      "createAdminClient",
      "admin-server",
      "service_role",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]) {
      expect(
        DATA_ACTIONS,
        `export must not reach for ${forbidden}; exposure incidents are owner-only via RLS`,
      ).not.toContain(forbidden);
    }
    // Positive control: it really does use the RLS-scoped authenticated client.
    expect(DATA_ACTIONS).toMatch(/from "@\/lib\/supabase\/server"/);
  });

  it("pagination did not smuggle in a second client", () => {
    // Assert on IMPORTS, not on any occurrence of the word. A first version of
    // this test used `.not.toContain("supabase")` and failed on a COMMENT
    // citing supabase/config.toml — a guard a comment can satisfy is a guard
    // that proves nothing about the code.
    const PAGINATE = read("lib/export/paginate.ts");
    const imports = PAGINATE.match(/^\s*import .*$/gm) ?? [];
    expect(imports, "the helper must stay dependency-free").toEqual([]);
    expect(PAGINATE).not.toMatch(/createClient|createAdminClient/);
  });
});

describe("#9 — the reminder scheduler is documented as operationally unproven", () => {
  const CRON_DOC = read("docs/08_EMAIL_SMS_AND_CRON.md");
  const CURRENT_STATE = read("docs/production/current-state.md");

  it("code-proven and production-unverified are stated as different claims", () => {
    expect(CRON_DOC).toMatch(/PRODUCTION OPERATION/);
    expect(CRON_DOC).toMatch(/OPEN — requires externally verified evidence/);
  });

  it("the objective verification checklist exists", () => {
    for (const item of [
      /owner named/i,
      /exists and is \*\*enabled\*\*|exists and is enabled/i,
      /Cadence \*\*≤ 15 minutes\*\*|≤ 15 minutes/,
      /CRON_SECRET/,
      /Recent successful executions visible/i,
      /alerting\/monitoring ownership named/i,
      /No second competing scheduler/i,
    ]) {
      expect(CRON_DOC).toMatch(item);
    }
  });

  it("current-state does not claim reminder delivery is verified", () => {
    expect(CURRENT_STATE).toMatch(/production operation UNVERIFIED \(OPEN\)/i);
  });
});
