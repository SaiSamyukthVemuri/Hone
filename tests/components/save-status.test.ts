import { describe, expect, it } from "vitest";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SaveStatus } = await import("@/components/sessions/save-status");

const html = (state: Parameters<typeof SaveStatus>[0]["state"], onRetry?: () => void) =>
  renderToStaticMarkup(createElement(SaveStatus, { state, onRetry }));

describe("SaveStatus", () => {
  it("shows each state as a polite status", () => {
    const cases: Array<[Parameters<typeof html>[0], string]> = [
      [{ status: "unsaved" }, "Unsaved changes"],
      [{ status: "saving" }, "Saving…"],
      [{ status: "saved" }, "Saved"],
      [{ status: "failed", message: "Check the connection." }, "Couldn&#x27;t save"],
    ];
    for (const [state, text] of cases) {
      const out = html(state, () => undefined);
      expect(out).toContain('role="status"');
      expect(out).toContain('aria-live="polite"');
      expect(out).toContain(text);
    }
  });
  it("offers Try again only after a failure, with the message", () => {
    expect(html({ status: "saved" }, () => undefined)).not.toContain("Try again");
    const out = html({ status: "failed", message: "Check the connection." }, () => undefined);
    expect(out).toContain("Try again");
    expect(out).toContain("Check the connection.");
  });
  it("uses no pronouns", () => {
    expect(html({ status: "failed", message: "x" }, () => undefined)).not.toMatch(/\b(she|he|her|his|they)\b/i);
  });
});
