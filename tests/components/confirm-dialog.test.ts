import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Chloe workflow fix. Source-grep pins for the accessible ConfirmDialog that
// replaces native window.confirm() for consequential practitioner actions
// (Mark completed / Mark no-show). window.confirm is unreliable on iOS Safari
// (WebKit can suppress it and return false silently); this dialog removes that
// class of failure and is keyboard + screen-reader accessible. Real interactive
// behavior (focus trap, Escape, one-request, 44px targets) is additionally
// exercised by the WebKit iPhone E2E lane; these pins lock the load-bearing
// structure in the fast, Docker-free unit lane.

const PATH = path.resolve(
  __dirname,
  "../../components/confirm-dialog.tsx",
);
const SRC = readFileSync(PATH, "utf8");

function codeOnly(src: string): string {
  return src
    // Strip JSX {/* ... */} and /* ... */ block comments, then // line
    // comments, so explanatory prose (which legitimately mentions "sticky",
    // "resend", etc. when describing what the component avoids) never trips a
    // negative source assertion.
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const CODE = codeOnly(SRC);

describe("ConfirmDialog: client component + accessible roles", () => {
  it("declares 'use client'", () => {
    expect(SRC).toMatch(/^"use client";/);
  });

  it("uses role=alertdialog + aria-modal for a confirmation dialog", () => {
    expect(SRC).toMatch(/role="alertdialog"/);
    expect(SRC).toMatch(/aria-modal="true"/);
  });

  it("labels + describes the dialog via useId (title + description)", () => {
    expect(SRC).toMatch(/const titleId = useId\(\)/);
    expect(SRC).toMatch(/const descId = useId\(\)/);
    expect(SRC).toMatch(/aria-labelledby=\{titleId\}/);
    expect(SRC).toMatch(/aria-describedby=\{descId\}/);
  });
});

describe("ConfirmDialog: focus management", () => {
  it("captures the opener and restores focus to it on close", () => {
    expect(SRC).toMatch(/openerRef\.current = document\.activeElement/);
    expect(SRC).toMatch(/opener instanceof HTMLElement.*opener\.focus\(\)/s);
  });

  it("moves focus into the dialog on open", () => {
    expect(SRC).toMatch(/confirmRef\.current\?\.focus\(\)/);
  });

  it("implements a focus trap (cycles Tab/Shift+Tab; parks on the panel when all disabled)", () => {
    expect(SRC).toMatch(/const FOCUSABLE =/);
    expect(SRC).toMatch(/e\.key !== "Tab"/);
    expect(SRC).toMatch(/e\.shiftKey && active === first/);
    expect(SRC).toMatch(/panel\.focus\(\)/);
  });
});

describe("ConfirmDialog: idle-gated dismissal (never abandons an in-flight request)", () => {
  it("Escape closes only when NOT pending", () => {
    expect(SRC).toMatch(/e\.key === "Escape"/);
    expect(SRC).toMatch(/if \(!pending\) onCancel\(\)/);
  });

  it("backdrop mousedown closes only when NOT pending", () => {
    expect(SRC).toMatch(/e\.target === e\.currentTarget && !pending.*onCancel\(\)/s);
  });
});

describe("ConfirmDialog: buttons, submit-lock, mobile targets", () => {
  it("renders explicit Confirm and Cancel buttons", () => {
    expect(SRC).toMatch(/data-testid="confirm-dialog-confirm"/);
    expect(SRC).toMatch(/data-testid="confirm-dialog-cancel"/);
  });

  it("both buttons meet the 44px mobile target minimum", () => {
    const buttons = SRC.match(/<button[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const b of buttons) expect(b).toMatch(/min-h-\[44px\]/);
  });

  it("disables both buttons while pending (one request per confirmation)", () => {
    const buttons = SRC.match(/<button[\s\S]*?<\/button>/g) ?? [];
    for (const b of buttons) expect(b).toMatch(/disabled=\{pending\}/);
  });

  it("surfaces a caller-supplied error in an assertive alert region", () => {
    expect(SRC).toMatch(/role="alert"/);
  });
});

describe("ConfirmDialog: presentational only (owns no mutation)", () => {
  it("never calls a server action, Stripe, email, SMS, or window.confirm", () => {
    expect(CODE).not.toMatch(/window\.confirm/);
    expect(CODE).not.toMatch(/paymentIntents|charges\.create|refunds\.create/);
    expect(CODE).not.toMatch(/sendEmailSafely|sendSms|twilio|resend/i);
    expect(CODE).not.toMatch(/Action\(/);
  });
});

describe("ConfirmDialog: iOS Safari paint hardening", () => {
  it("header/footer are shrink-0 (never position:sticky) with safe-area footer padding", () => {
    // Check comment-stripped CODE so the explanatory "sticky" in the header
    // comment doesn't trip the negative assertion.
    expect(CODE).toMatch(/shrink-0/);
    expect(CODE).not.toMatch(/sticky/);
    expect(CODE).toMatch(/env\(safe-area-inset-bottom\)/);
  });
});
