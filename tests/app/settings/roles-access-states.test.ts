import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", async (orig) => ({ ...(await orig<Record<string, unknown>>()), useRouter: () => ({ push: vi.fn() }) }));
const { AccessStateView, ACCESS_EMPTY_LINE } = await import("@/app/(app)/settings/roles/roles-editor");

const html = (state: Parameters<typeof AccessStateView>[0]["state"], onRetry?: () => void) => renderToStaticMarkup(createElement(AccessStateView, { state, onRetry }));

describe("View access: loading, error and empty states", () => {
  it("loading is a status, not a list", () => {
    const h = html({ kind: "loading" });
    expect(h).toContain('role="status"');
    expect(h).toContain('data-access-state="loading"');
    expect(h).not.toContain("Access in force right now");
  });
  it("an error is an alert with the message and a retry", () => {
    const h = html({ kind: "error", message: "Could not read access." }, () => undefined);
    expect(h).toContain('role="alert"');
    expect(h).toContain("Could not read access.");
    expect(h).toContain('data-testid="access-retry"');
    expect(h).not.toContain('data-access-row');
  });
  it("without a retry handler no retry button is drawn", () => {
    expect(html({ kind: "error", message: "x" })).not.toContain("access-retry");
  });
  it("zero rows says nothing came back and does NOT claim access in force", () => {
    const h = html({ ok: true, state: "active", role: "practitioner", rows: [] });
    expect(h).toContain(ACCESS_EMPTY_LINE);
    expect(h).toContain('data-access-state="empty"');
    expect(h).not.toContain("Access in force right now");
    expect(h).not.toMatch(/<ul/);
  });
  it("rows still render as before, with the database note", () => {
    const h = html({ ok: true, state: "active", role: "practitioner", rows: [{ key: "appt.book", scope: "studio", source: "stored", cappedBy: null }] });
    expect(h).toContain('data-access-row="appt.book"');
    expect(h).toContain("The database does not check these settings yet.");
  });
});
