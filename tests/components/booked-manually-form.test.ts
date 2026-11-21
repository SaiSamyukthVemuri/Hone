import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/(app)/settings/waitlist/booked-manually-actions", () => ({ bookedManuallyAction: async () => undefined }));
import { BOOKED_MANUALLY_MEANING, BookedManuallyForm, BookedManuallyNotice } from "@/components/waitlist/booked-manually-form";
import { BOOKED_MANUALLY_COPY } from "@/lib/waitlist/booked-manually-notice";

const E = "33333333-3333-4333-8333-333333333333";
const html = (c: readonly { id: string; label: string }[]) => renderToStaticMarkup(createElement(BookedManuallyForm, { entryId: E, choices: c }));

describe("BookedManuallyForm", () => {
  it("offers every appointment passed, not a capped few", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`, label: `Appointment ${i}` }));
    expect((html(many).match(/<option /g) ?? []).length).toBe(26);
  });
  it("carries the entry id and requires an appointment choice", () => {
    const h = html([{ id: "44444444-4444-4444-8444-444444444444", label: "A" }]);
    expect(h).toContain(`name="entryId" value="${E}"`);
    expect(h).toMatch(/<select[^>]*name="appointmentId"[^>]*required/);
  });
  it("the mismatch confirmation is an unticked checkbox", () => {
    const h = html([{ id: "x", label: "A" }]);
    expect(h).toMatch(/<input[^>]*type="checkbox"[^>]*name="confirmEmailMismatch"|<input[^>]*name="confirmEmailMismatch"[^>]*type="checkbox"/);
    expect(h).not.toMatch(/checked/);
  });
  it("says it sends nothing, and shows how to proceed with no appointment", () => {
    expect(html([{ id: "x", label: "A" }])).toContain(BOOKED_MANUALLY_MEANING);
    expect(BOOKED_MANUALLY_MEANING).toMatch(/Nothing is sent/);
    const none = html([]);
    expect(none).toContain("booked-manually-none");
    expect(none).not.toContain("<form");
  });
});

describe("BookedManuallyNotice", () => {
  it("renders nothing without a result", () => {
    expect(renderToStaticMarkup(createElement(BookedManuallyNotice, { result: null }))).toBe("");
  });
  it("success is a status, a refusal is an alert, with the closed copy", () => {
    const ok = renderToStaticMarkup(createElement(BookedManuallyNotice, { result: "booked" }));
    expect(ok).toContain('role="status"');
    expect(ok).toContain(BOOKED_MANUALLY_COPY.booked);
    const bad = renderToStaticMarkup(createElement(BookedManuallyNotice, { result: "email_mismatch" }));
    expect(bad).toContain('role="alert"');
    expect(bad).toContain('data-ok="0"');
  });
});
