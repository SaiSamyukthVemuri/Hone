import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");
const PAGE = read("app/(app)/clients/[id]/page.tsx");

/** The JSX of one tab block, from its opening condition to the next tab block. */
function tabBlock(open: string): string {
  const i = PAGE.indexOf(open);
  expect(i, open).toBeGreaterThan(-1);
  const rest = PAGE.slice(i + open.length);
  const next = rest.search(/\n      \{activeTab === "/);
  return PAGE.slice(i, next === -1 ? undefined : i + open.length + next);
}

describe("Billing is owner-only on the server (card, authorization, pricing)", () => {
  it("every card-on-file / authorization / pricing control sits inside the owner Billing block", () => {
    const billing = tabBlock('{activeTab === "billing" && isOwner && (');
    for (const needle of ["<PaymentMethodCard", "<AddPricingForm", "cardAuthTemplate"]) {
      expect(PAGE.split(needle).length - 1, needle).toBe(billing.split(needle).length - 1);
      expect(billing, needle).toContain(needle);
    }
  });
  it("the card read runs only for an owner on the Billing tab", () => {
    expect(PAGE).toMatch(/const isOwnerBilling = activeTab === "billing" && isOwner;/);
    expect(PAGE).toMatch(/const needsCard = isOwnerBilling;/);
    expect(PAGE).toMatch(/needsCard\s*\?\s*getActiveCardForStudioClient\(/);
    expect((PAGE.match(/getActiveCardForStudioClient\(/g) ?? []).length).toBe(1);
  });
  it("a non-owner asking for ?tab=billing is redirected to Overview before any tab read", () => {
    const at = PAGE.indexOf("resolveProfileTab(sp.tab");
    expect(at).toBeGreaterThan(-1);
    expect(PAGE).toMatch(/if \(resolved\.denied \|\| isLegacyProfileTab\(sp\.tab\)\) \{/);
    // the redirect precedes the data window and every read wave
    expect(PAGE.indexOf("redirect(`/clients/")).toBeLessThan(PAGE.indexOf('startPerfSpan("client-profile.domain")'));
    expect(PAGE.indexOf("redirect(`/clients/")).toBeLessThan(PAGE.indexOf("getClientById("));
  });
  it("the one session price on Sessions renders only from a price the loader returned (null for a non-owner)", () => {
    expect(tabBlock('{activeTab === "sessions" && (')).toMatch(
      /lastTreatment\.price_paid_cents != null &&\s*` · Session price/,
    );
  });
  it("no billing control is rendered on any other tab", () => {
    for (const open of ['{activeTab === "overview" && (', '{activeTab === "messages" && (', '{activeTab === "sessions" && (']) {
      const b = tabBlock(open);
      expect(b, open).not.toMatch(/<PaymentMethodCard|<AddPricingForm|lifetimeCents/);
    }
  });
});

describe("old links redirect, and nothing scrolls", () => {
  it("the redirect target has no fragment and keeps create_plan/returnTo only for Treatment", () => {
    const i = PAGE.indexOf("if (resolved.denied || isLegacyProfileTab(sp.tab)) {");
    const block = PAGE.slice(i, PAGE.indexOf("const activeTab: ProfileTab = resolved.tab;"));
    expect(block).not.toContain("#");
    expect(block).toMatch(/resolved\.tab === "treatment" && sp\.create_plan === "1"/);
    expect(block).toMatch(/resolved\.tab === "treatment" && sp\.returnTo/);
  });
  it("create_plan is honoured on Treatment only", () => {
    expect(PAGE).toMatch(/const autoOpenCreatePlan = sp\.create_plan === "1" && activeTab === "treatment";/);
  });
});

describe("opening a profile writes nothing", () => {
  it("the page issues no insert, update, delete, upsert or rpc", () => {
    expect(PAGE).not.toMatch(/\.(insert|update|delete|upsert|rpc)\(/);
    expect(PAGE).not.toMatch(/createAdminClient|markReviewed|markComplete/);
  });
  it("the profile tab modules have no write path or session creation", () => {
    for (const f of ["lib/clients/profile-tabs.ts", "lib/clients/profile-visits.ts", "lib/clients/profile-avatar.ts", "lib/clients/profile-pricing.ts"]) {
      expect(read(f), f).not.toMatch(/\.(insert|update|delete|upsert|rpc)\(|createClient|createAdminClient/);
    }
  });
});

describe("per-tab loading (PERF2) covers every tab that reads", () => {
  it("the deferred-read contract names each reading tab, and Photos reads nothing", () => {
    const i = PAGE.indexOf("requireLoadedForTab(activeTab, {");
    const block = PAGE.slice(i, PAGE.indexOf("\n  });", i));
    for (const tab of ["overview", "sessions", "treatment", "messages", "health", "notes", "billing"]) {
      expect(block, tab).toMatch(new RegExp(`\\n    ${tab}: \\{`));
    }
    expect(block).not.toMatch(/\n    photos: \{/);
  });
  it("portal access, consent and pending tasks are not read for Overview", () => {
    expect(PAGE).toMatch(/const needsPortalMessages = isMessages;/);
    expect(PAGE).toMatch(/isMessages\s*\?\s*getPortalAccessSummary\(/);
    expect(PAGE).toMatch(/isMessages\s*\?\s*getRecentPortalAccessEvents\(/);
  });
});

describe("the header is initials only (independent of the held identification photo)", () => {
  it("no portrait read or component remains in the page", () => {
    expect(PAGE).not.toMatch(/ClientPortrait|signedClientPortraitUrl|clientPortraitEnabled|portrait_image_id|0275/);
    expect(PAGE).toContain("clientAvatarInitials(client.name)");
  });
});
