import { beforeEach, describe, expect, it, vi } from "vitest";
import { clientPreheader } from "@/lib/email/preheader";
import { plainTextPreview, previewLeaks, simulatedPreview } from "./helpers/email-preview";

// HIPAA-READY-01 (#828): the "appointment updated" email a practitioner's move
// sends. It carries the client preheader, so its filler-stripped and plain-text
// previews are held to the same rule as every other preheader-bearing template
// (preheader-minimum-necessary.test.ts): within the preview window the body
// names only the studio. Every value is synthetic.

const sent = vi.hoisted(() => [] as Array<{ subject: string; html: string; text: string }>);

vi.mock("@/lib/email/send-appointment", () => ({
  sendEmailSafely: async (opts: { subject: string; html: string; text: string }) => {
    sent.push({ subject: opts.subject, html: opts.html, text: opts.text });
    return { ok: true, messageId: "synthetic" };
  },
}));
vi.mock("@/lib/booking/tokens", () => ({ generateCancellationToken: () => "tok_SYNTH" }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async () => {} }));

import { notifyAppointmentMoved, type MoveNotificationKind } from "@/lib/email/notify-appointment-moved";

const STUDIO = "Synthetic Studio";

function admin() {
  const row = {
    id: "appt",
    starts_at: "2031-03-04T20:45:00Z",
    client: { name: "Zephyrine Synthetic-Client", email: "client@synthetic.invalid" },
    service: { name: "Synthetic Upper Lip Electrolysis" },
    studio: { name: STUDIO, timezone: "America/Toronto", owner_email: null, postcare_contact_email: null },
    practitioner: { display_name: "Synthetic Practitioner" },
  };
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return { from: () => chain } as never;
}

describe("appointment moved email: the preview names only the studio", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it.each<MoveNotificationKind>(["moved", "reassigned", "moved_and_reassigned"])("%s", async (kind) => {
    const status = await notifyAppointmentMoved(admin(), {
      appointmentId: "appt",
      studioId: "studio",
      appOrigin: "https://hone.care",
      resultKind: kind,
    });
    expect(status).toBe("sent");
    expect(sent).toHaveLength(1);
    const { subject, html, text } = sent[0];
    const expected = clientPreheader(STUDIO);
    const preview = simulatedPreview(html);
    expect(preview.startsWith(expected)).toBe(true);
    expect(previewLeaks(subject, preview.slice(expected.length)), preview).toEqual([]);
    expect(previewLeaks(subject, plainTextPreview(text)), text).toEqual([]);
    // The details are still in the body, after the opening.
    expect(text).toMatch(/Synthetic Upper Lip Electrolysis/);
  });
});
