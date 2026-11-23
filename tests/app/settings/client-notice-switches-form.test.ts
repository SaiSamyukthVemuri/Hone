import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// The email settings form shows the two client-notice switches (0373) only when the studio row carries them as booleans. Before the
// migration is applied they are hidden, so an owner is never shown a switch that saves but changes nothing.

vi.mock("@/app/(app)/settings/studio/actions", () => ({ setStudioEmailSettingsAction: vi.fn() }));
vi.mock("../../../app/(app)/settings/studio/actions", () => ({ setStudioEmailSettingsAction: vi.fn() }));

import { EmailSettingsForm } from "@/app/(app)/settings/studio/EmailSettingsForm";

const BASE = {
  send_confirmation_emails: true,
  notify_practitioner_on_new_booking: true,
  send_24h_reminders: true,
  send_2h_reminders: true,
  send_intake_reminders: true,
  auto_mark_no_shows: false,
  send_no_show_followup: false,
  show_treatment_time_to_clients: false,
};
const MOVED = "Tell the client when I move their appointment";
const CANCEL = "Tell the client when I cancel their appointment";
const html = (extra: Record<string, unknown>) => renderToStaticMarkup(createElement(EmailSettingsForm, { initial: { ...BASE, ...extra } as never }));

describe("the client-notice switches in the email settings form", () => {
  it("before 0373 (the studio row has neither column) neither switch is shown, and the other settings still are", () => {
    const out = html({});
    expect(out).not.toContain(MOVED);
    expect(out).not.toContain(CANCEL);
    expect(out).toContain("Send confirmation emails when appointments are booked");
    expect(out).toContain("Send 24-hour reminders");
  });

  it("after 0373 both are shown, with their saved positions", () => {
    const out = html({ send_moved_appointment_emails: true, send_client_cancellation_emails: false });
    expect(out).toContain(MOVED);
    expect(out).toContain(CANCEL);
    expect(out).toMatch(new RegExp(`aria-label="${MOVED}"[^>]*aria-pressed="true"`));
    expect(out).toMatch(new RegExp(`aria-label="${CANCEL}"[^>]*aria-pressed="false"`));
  });

  it("a non-boolean value (a malformed row) hides the switch rather than guessing", () => {
    const out = html({ send_moved_appointment_emails: "true", send_client_cancellation_emails: null });
    expect(out).not.toContain(MOVED);
    expect(out).not.toContain(CANCEL);
  });
});
