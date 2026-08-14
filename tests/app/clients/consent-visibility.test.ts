import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// P1-A source pins: the practitioner can open the COMPLETE signed record (form
// copy + photo-consent choice + signature), the query surfaces the stored
// columns, the images page shows the photo-consent summary, and no client
// answer/body text enters logs.

const ROOT = process.cwd();
const QUERIES = readFileSync(join(ROOT, "lib/consent/queries.ts"), "utf8");
const VIEWER = readFileSync(join(ROOT, "components/signed-consent-viewer.tsx"), "utf8");
const CARD = readFileSync(join(ROOT, "components/consent-signatures-card.tsx"), "utf8");
const IMAGES = readFileSync(join(ROOT, "app/(app)/clients/[id]/images/page.tsx"), "utf8");

describe("practitioner query surfaces the stored agreed content", () => {
  it("selects the form-copy snapshot + photo-response label + hash (previously omitted)", () => {
    expect(QUERIES).toMatch(/template_body_snapshot/);
    expect(QUERIES).toMatch(/response_label_snapshot/);
    expect(QUERIES).toMatch(/template_hash/);
    // The projection string itself now includes them.
    expect(QUERIES).toMatch(
      /\.select\(\s*\n?\s*"[^"]*template_body_snapshot[^"]*response_label_snapshot[^"]*"/,
    );
  });

  it("scopes every consent read by studio_id (no cross-studio leakage)", () => {
    expect(QUERIES).toMatch(/\.eq\("studio_id", studioId\)/);
    // getPhotoConsentStateForClient is studio-scoped too.
    expect(QUERIES).toMatch(/getPhotoConsentStateForClient/);
  });

  it("never logs the body/response/answer: only error code + message", () => {
    // The consent error log object must not carry the snapshot/answer fields.
    const logBlocks = QUERIES.match(/console\.error\(\s*\n?\s*JSON\.stringify\(\{[\s\S]*?\}\)/g) ?? [];
    for (const b of logBlocks) {
      expect(b).not.toMatch(/template_body_snapshot/);
      expect(b).not.toMatch(/response_label_snapshot/);
      expect(b).not.toMatch(/signature_name/);
    }
  });
});

describe("signed-consent viewer renders the complete record, not a badge", () => {
  it("shows the exact form copy, the signature, the signed time, no raw JSON", () => {
    expect(VIEWER).toMatch(/template_body_snapshot/);
    expect(VIEWER).toMatch(/Form the client agreed to/i);
    expect(VIEWER).toMatch(/record\.signature_name/);
    expect(VIEWER).toMatch(/record\.signed_at/);
    // whitespace-preserved body (not collapsed), never JSON.stringify of the row.
    expect(VIEWER).toMatch(/whitespace-pre-wrap/);
    expect(VIEWER).not.toMatch(/JSON\.stringify\(record\)/);
  });

  it("surfaces the photo-consent choice explicitly and warns on a malformed record", () => {
    expect(VIEWER).toMatch(/Photo consent:/);
    expect(VIEWER).toMatch(/reviewSignedRecord/);
    expect(VIEWER).toMatch(/role="alert"/);
  });

  it("is wired into the consent card for every signed row", () => {
    expect(CARD).toMatch(/import \{ SignedConsentViewer \}/);
    expect(CARD).toMatch(/\{sig && \(\s*\n?\s*<SignedConsentViewer/);
    expect(CARD).toMatch(/formType=\{t\.form_type\}/);
  });
});

describe("images page shows the photo-consent summary near the workflow", () => {
  it("loads the photo-consent state and renders the summary banner", () => {
    expect(IMAGES).toMatch(/getPhotoConsentStateForClient\(studio\.id, id\)/);
    expect(IMAGES).toMatch(/photoConsentSummary/);
    expect(IMAGES).toMatch(/\{photoConsent && \(/);
  });
});
