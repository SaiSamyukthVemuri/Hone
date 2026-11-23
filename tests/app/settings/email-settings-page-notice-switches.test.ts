import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The email settings PAGE decides what the form is given. Before migration 0373 is applied the studio row has neither notice column, and
// the page must pass them through as absent: defaulting them to on here would show a switch that saves but changes nothing. This test
// goes through the page itself (the form test feeds the form directly and cannot see the page's defaults).

const h = vi.hoisted(() => ({ studio: {} as Record<string, unknown> }));
vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: async () => ({ practitioner: { id: "p-1", role: "owner" }, studio: h.studio }),
}));
vi.mock("@/app/(app)/settings/studio/actions", () => ({ setStudioEmailSettingsAction: vi.fn() }));

import StudioEmailPage from "@/app/(app)/settings/studio/email/page";

const MOVED = "Tell the client when I move their appointment";
const CANCEL = "Tell the client when I cancel their appointment";
const ROW = {
  send_confirmation_emails: true,
  notify_practitioner_on_new_booking: true,
  send_24h_reminders: true,
  send_2h_reminders: true,
  auto_mark_no_shows: false,
  send_no_show_followup: false,
  show_treatment_time_to_clients: false,
};
const render = async () => renderToStaticMarkup(await StudioEmailPage());

beforeEach(() => {
  h.studio = { ...ROW };
});

describe("the email settings page and the two client-notice switches", () => {
  it("a studio row from before 0373 (neither column) renders neither switch, and the other settings still render", async () => {
    const out = await render();
    expect(out).not.toContain(MOVED);
    expect(out).not.toContain(CANCEL);
    expect(out).toContain("Send 24-hour reminders");
  });

  it("a studio row after 0373 renders both switches in their saved positions", async () => {
    h.studio = { ...ROW, send_moved_appointment_emails: false, send_client_cancellation_emails: true };
    const out = await render();
    expect(out).toMatch(new RegExp(`aria-label="${MOVED}"[^>]*aria-pressed="false"`));
    expect(out).toMatch(new RegExp(`aria-label="${CANCEL}"[^>]*aria-pressed="true"`));
  });
});
