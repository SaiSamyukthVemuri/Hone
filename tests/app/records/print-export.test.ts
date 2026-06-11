import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// PR #207: inspector-friendly print/export for Record Keeping.
// Browser-print view under the authenticated (app) layout; history
// opt-in via ?history=1; "Not recorded" for missing data; no public
// export route, no file storage, no compliance claims.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const PRINT = read("app/(app)/records/print/page.tsx");
const BUTTON = read("app/(app)/records/print/print-button.tsx");
const RECORDS = read("app/(app)/records/page.tsx");
const LAYOUT = read("app/(app)/layout.tsx");

describe("entry points + protection", () => {
  it("a Print / Export button links the active section to the print view", () => {
    expect(RECORDS).toMatch(/Print \/ Export/);
    expect(RECORDS).toMatch(/\/records\/print\?section=\$\{section\}/);
  });

  it("the print route lives under the authenticated (app) layout and resolves the studio server-side", () => {
    expect(PRINT).toMatch(/getCurrentPractitionerWithStudio/);
    expect(PRINT).not.toMatch(/"use client"/);
    // Same auth posture as /records: anonymous hits redirect via the
    // (app) layout; there is no parallel public route.
    expect(() =>
      read("app/records/print/page.tsx"),
    ).toThrow();
  });

  it("no public export route, storage, or email path exists", () => {
    const out = execSync(
      'grep -rl "records/print" app/book app/portal app/intake app/cancel app/reschedule lib/email app/api 2>/dev/null || true',
      { cwd: process.cwd() },
    )
      .toString()
      .trim();
    expect(out).toBe("");
    expect(PRINT).not.toMatch(/sendEmail|createSignedUrl|storage\./);
  });
});

describe("print document", () => {
  it("includes studio name, section title, and generated timestamp", () => {
    expect(PRINT).toMatch(/\{studio\.name\} · Generated \{generatedAt\}/);
    expect(PRINT).toMatch(/Sterile Items Records/);
    expect(PRINT).toMatch(/Disinfectant Records/);
    expect(PRINT).toMatch(/Accidental Blood\/Body Fluid Exposure Records/);
    expect(PRINT).toMatch(/Client Records for Invasive Procedures/);
  });

  it("uses window.print with the app chrome hidden in print media", () => {
    expect(BUTTON).toMatch(/window\.print\(\)/);
    expect(LAYOUT).toMatch(/print:hidden/);
    expect(PRINT).toMatch(/print:hidden/);
  });

  it("sterile items print fields render", () => {
    for (const f of [
      "Date purchased",
      "Item description",
      "Manufacturer",
      "Amount purchased",
      "Lot #",
      "Expiry date",
    ]) {
      expect(PRINT).toMatch(new RegExp(`label="${f}"`));
    }
  });

  it("disinfectant print fields render, with In use for undiscarded batches", () => {
    for (const f of [
      "Date prepared",
      "Disinfectant",
      "Concentration",
      "Date discarded",
      "Operator",
    ]) {
      expect(PRINT).toMatch(new RegExp(`label="${f}"`));
    }
    expect(PRINT).toMatch(/"In use"/);
  });

  it("exposure incident print fields render", () => {
    for (const f of [
      "Incident date",
      "Exposed person",
      "Address",
      "Phone",
      "How the exposure occurred",
      "Action taken",
      "Staff involved",
    ]) {
      expect(PRINT).toMatch(new RegExp(`label="${f}"`));
    }
  });

  it("procedure record print fields render, including lots and aftercare status", () => {
    for (const f of [
      "Date of service",
      "Client",
      "Date of birth",
      "Phone",
      "Email",
      "Address",
      "Service",
      "Operator",
    ]) {
      expect(PRINT).toMatch(new RegExp(`label="${f}"`));
    }
    expect(PRINT).toMatch(/Items used:/);
    expect(PRINT).toMatch(/notRecorded\(a\.probeLotNumber\)/);
    expect(PRINT).toMatch(
      /label="Risks explained and aftercare information provided"/,
    );
  });

  it("missing values render Not recorded; nothing is invented", () => {
    expect(PRINT).toMatch(/return t && t\.length > 0 \? t : "Not recorded";/);
    expect(PRINT).toMatch(/Missing\s*\n?\s*information is shown as Not recorded\./);
  });

  it("history is opt-in (?history=1) and off by default", () => {
    expect(PRINT).toMatch(/const includeHistory = sp\.history === "1";/);
    expect(PRINT).toMatch(/Include history/);
    // The Records-page button links WITHOUT history.
    expect(RECORDS).not.toMatch(/records\/print\?section=\$\{section\}&history/);
  });
});

describe("safety", () => {
  it("no compliance guarantee language", () => {
    for (const phrase of [
      /\bcompliant\b/i,
      /inspection approved/i,
      /\bcertified\b/i,
      /\bguaranteed\b/i,
      /meets all legal/i,
    ]) {
      expect(PRINT).not.toMatch(phrase);
      expect(BUTTON).not.toMatch(phrase);
    }
  });

  it("no payment surface", () => {
    expect(PRINT).not.toMatch(/stripe|payment/i);
  });
});
