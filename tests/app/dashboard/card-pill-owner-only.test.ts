import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Privacy F1 (1 Nov), Sam decision 12: card-on-file is a client payment-readiness
// signal, so it is OWNER-ONLY, like payment state. A practitioner neither sees the
// pill nor makes the server run the card read. Source contracts, like the other
// HON-44 surface pins: the page is a server component. The browser proof (a
// practitioner payload with no card wording, an owner control) belongs to Photos.

const PAGE = readFileSync(join(process.cwd(), "app/(app)/dashboard/page.tsx"), "utf8");

describe("dashboard card-on-file is owner-only", () => {
  it("the card read sits behind isOwner and a non-owner gets no load at all", () => {
    expect(PAGE).toMatch(
      /isOwner\s*\?\s*loadCardOnFileForStudio\(studio\.id, selectedDayClientIds\)\s*:\s*Promise\.resolve\(null\)/,
    );
    // Still exactly one call site, so there is no second, ungated path.
    expect((PAGE.match(/loadCardOnFileForStudio\(/g) ?? []).length).toBe(1);
  });

  it("the pill renders for an owner only", () => {
    expect(PAGE).toContain("{isOwner && <CardOnFilePill status={cardOnFile} />}");
    expect((PAGE.match(/<CardOnFilePill/g) ?? []).length).toBe(1);
  });

  it("with no load the status resolves to null, so no pill and no portal-link nudge", async () => {
    const { resolveCardOnFileStatus, shouldOfferPortalLink } = await import(
      "@/lib/payment-methods/card-on-file"
    );
    const status = resolveCardOnFileStatus(null, "any-client");
    expect(status).toBeNull();
    expect(shouldOfferPortalLink(status)).toBe(false);
  });

  it("owner positive control: a loaded read still resolves a status", async () => {
    const { resolveCardOnFileStatus } = await import("@/lib/payment-methods/card-on-file");
    const load = { ok: true, clientsWithActiveCard: new Set(["c1"]) } as never;
    expect(resolveCardOnFileStatus(load, "c1")).toBe("card_on_file");
    expect(resolveCardOnFileStatus(load, "c2")).toBe("no_card");
  });

  it("the isOwner the page passes is derived from the server-resolved role", () => {
    expect(PAGE).toContain('const isOwner = practitioner.role === "owner";');
  });
});
