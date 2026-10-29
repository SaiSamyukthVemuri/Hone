import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FeeAmountsCard } from "@/app/(app)/settings/payments/FeeAmountsCard";

// #1035 Codex P1 #4369182087. The late-cancellation / no-show fee inputs print
// the studio's VERIFIED currency (resolved on the server), never a literal CAD.
const render = (currencyLabel: "CAD" | "USD" | null) =>
  renderToStaticMarkup(createElement(FeeAmountsCard, { initialLateCancelCents: 2500, initialNoShowCents: 5000, currencyLabel } as never));

describe("fee amount inputs print the verified studio currency", () => {
  it("US studio: both inputs say USD, none says CAD", () => {
    const html = render("USD");
    expect((html.match(/data-testid="fee-currency"[^>]*>USD</g) ?? []).length).toBe(2);
    expect(html).not.toContain("CAD");
  });
  it("CA studio: both inputs say CAD", () => {
    const html = render("CAD");
    expect((html.match(/data-testid="fee-currency"[^>]*>CAD</g) ?? []).length).toBe(2);
    expect(html).not.toContain("USD");
  });
  it("unknown jurisdiction: says 'currency not confirmed', prints neither code", () => {
    const html = render(null);
    expect((html.match(/currency not confirmed/g) ?? []).length).toBe(2);
    expect(html).not.toMatch(/\bCAD\b|\bUSD\b/);
  });
});
