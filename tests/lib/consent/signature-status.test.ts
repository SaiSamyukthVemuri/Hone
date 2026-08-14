import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  consentRowState,
  consentRowNeedsAttention,
  summarizeConsent,
  type ConsentTemplateLite,
  type ConsentSigLite,
} from "@/lib/consent/signature-status";

// Pure behavioral tests for the practitioner consent-card status logic
// (signed / missing / OUTDATED + the pre-treatment summary). No DB / no DOM.

function tmpl(over: Partial<ConsentTemplateLite> = {}): ConsentTemplateLite {
  return { id: "t1", title: "T", form_type: "treatment_consent", version: 2, ...over };
}

describe("consentRowState", () => {
  it("no signature → not_signed (not_answered for photo)", () => {
    expect(consentRowState(tmpl(), undefined)).toBe("not_signed");
    expect(consentRowState(tmpl({ form_type: "photo_consent" }), undefined)).toBe(
      "not_answered",
    );
  });

  it("current-version signature → signed / granted / denied", () => {
    expect(consentRowState(tmpl({ version: 2 }), { template_version: 2 })).toBe("signed");
    expect(
      consentRowState(tmpl({ form_type: "photo_consent", version: 1 }), {
        template_version: 1,
        response: "accepted",
      }),
    ).toBe("granted");
    expect(
      consentRowState(tmpl({ form_type: "photo_consent", version: 1 }), {
        template_version: 1,
        response: "denied",
      }),
    ).toBe("denied");
  });

  it("older-version signature → outdated (needs re-sign)", () => {
    expect(consentRowState(tmpl({ version: 3 }), { template_version: 1 })).toBe("outdated");
    expect(
      consentRowState(tmpl({ form_type: "photo_consent", version: 2 }), {
        template_version: 1,
        response: "accepted",
      }),
    ).toBe("outdated");
  });

  it("card_authorization is NEVER outdated here (its re-sign flow is elsewhere)", () => {
    expect(
      consentRowState(tmpl({ form_type: "card_authorization", version: 5 }), {
        template_version: 1,
      }),
    ).toBe("signed");
  });
});

describe("consentRowNeedsAttention", () => {
  it("missing + outdated need attention; complete states do not", () => {
    expect(consentRowNeedsAttention("not_signed")).toBe(true);
    expect(consentRowNeedsAttention("not_answered")).toBe(true);
    expect(consentRowNeedsAttention("outdated")).toBe(true);
    expect(consentRowNeedsAttention("signed")).toBe(false);
    expect(consentRowNeedsAttention("granted")).toBe(false);
    expect(consentRowNeedsAttention("denied")).toBe(false); // answered, immutable
  });
});

describe("summarizeConsent (pre-treatment)", () => {
  const templates: ConsentTemplateLite[] = [
    { id: "photo", title: "Photo", form_type: "photo_consent", version: 1 },
    { id: "treat", title: "Treatment", form_type: "treatment_consent", version: 2 },
    { id: "ack", title: "Ack", form_type: "policy_acknowledgement", version: 1 },
    { id: "card", title: "Card", form_type: "card_authorization", version: 1 },
  ];

  it("counts non-card forms; missing + outdated feed needsAttention; card excluded", () => {
    const sigs = new Map<string, ConsentSigLite>([
      ["photo", { template_version: 1, response: "accepted" }], // granted (ok)
      ["treat", { template_version: 1 }], // outdated (current v2)
      // "ack" unsigned
      ["card", { template_version: 1 }], // excluded
    ]);
    const s = summarizeConsent(templates, sigs);
    expect(s.total).toBe(3); // card excluded
    expect(s.notSigned).toBe(1); // ack
    expect(s.outdated).toBe(1); // treat
    expect(s.needsAttention).toBe(2);
  });

  it("all current → needsAttention 0; denied photo counts as complete", () => {
    const sigs = new Map<string, ConsentSigLite>([
      ["photo", { template_version: 1, response: "denied" }], // answered, complete
      ["treat", { template_version: 2 }],
      ["ack", { template_version: 1 }],
    ]);
    const s = summarizeConsent(templates, sigs);
    expect(s.needsAttention).toBe(0);
    expect(s.total).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Source pins for the card wiring (vitest env is "node", no jsdom/RTL, so the
// rendered card cannot be DOM-tested; these pin the wiring, NOT rendered UI).
// ---------------------------------------------------------------------------
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}

describe("consent card wiring (source pins, NOT a DOM behavior test)", () => {
  const CARD = read("components/consent-signatures-card.tsx");
  const PAGE = read("app/(app)/clients/[id]/page.tsx");

  it("card uses consentRowState + summarizeConsent and renders Outdated + a pre-treatment summary", () => {
    expect(CARD).toMatch(/consentRowState\(t, sig\)/);
    expect(CARD).toMatch(/summarizeConsent\(activeTemplates, latestByTemplateId\)/);
    expect(CARD).toMatch(/label: "Outdated"/);
    expect(CARD).toMatch(/need attention before treatment/);
    expect(CARD).toMatch(/re-sign needed \(current v\{t\.version\}\)/);
  });

  it("client profile passes the template version into the card (enables outdated)", () => {
    expect(PAGE).toMatch(/version: t\.version/);
  });
});
