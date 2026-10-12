import { describe, expect, it, vi } from "vitest";

// PAY-CCY-04. The fee amount inputs name the studio's charge currency, and a
// failed currency read says so instead of showing nothing (the class of
// Codex P2 4249009847 / 4249448355). Rendered through react-dom/server.

vi.mock("@/app/(app)/settings/payments/fee-amounts-actions", () => ({
  updateStudioFeeAmountsAction: async () => ({ ok: true }),
}));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { FeeAmountsCard } = await import("@/app/(app)/settings/payments/FeeAmountsCard");

function render(currencyCode: "CAD" | "USD" | null): string {
  return renderToStaticMarkup(
    createElement(FeeAmountsCard, {
      initialLateCancelCents: 2500,
      initialNoShowCents: 5000,
      currencyCode,
    }),
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("fee amount inputs carry the studio's currency", () => {
  it("USD and CAD label both inputs", () => {
    expect(count(render("USD"), ">USD<")).toBe(2);
    expect(count(render("CAD"), ">CAD<")).toBe(2);
  });

  it("an unreadable currency is said out loud on both inputs, never blank or CAD", () => {
    const html = render(null);
    expect(count(html, "(currency unknown)")).toBe(2);
    expect(html).not.toMatch(/>CAD<|>USD</);
  });
});
