// HON-58: a client email carries the name the client goes by. Loader unit tests, the three senders rendered end to end with a
// captured transport, and a census of every email template. Synthetic names; the transport is a capture, nothing is sent.
const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const reads = vi.hoisted(() => ({ mode: "preferred" as "preferred" | "none" | "missing-column" | "error" | "throw" | "hang", calls: [] as string[] }));
vi.mock("@/lib/email/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/client")>()),
  getResendTransport: () => ({ emails: { send: async (p: Record<string, unknown>) => (sent.push(p), { data: { id: "captured" }, error: null }) } }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    if (reads.mode === "throw") throw new Error("no admin");
    return {
      from: (table: string) => {
        reads.calls.push(table);
        let cols = "";
        const q = {
          select: (c: string) => ((cols = c), q),
          eq: () => q,
          maybeSingle: async () => {
            if (reads.mode === "hang") return new Promise(() => {});
            if (reads.mode === "error") return { data: null, error: { code: "XX000", message: "boom" } };
            if (reads.mode === "missing-column" && cols.includes("preferred_name")) return { data: null, error: { code: "42703", message: "column clients.preferred_name does not exist" } };
            const preferred = reads.mode === "preferred" ? "Fern" : null;
            return table === "appointments"
              ? { data: { client: { name: "Quillon Sentinel", ...(cols.includes("preferred_name") ? { preferred_name: preferred } : {}) } }, error: null }
              : { data: { ...(cols.includes("preferred_name") ? { preferred_name: preferred } : {}), name: "Quillon Sentinel" }, error: null };
          },
        };
        return q;
      },
    };
  },
}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { loadCommunicationName, loadCommunicationNameForAppointment } from "@/lib/clients/communication-name-loader";
import { sendBookingConfirmationToClient, sendBookingNotificationToPractitioner, sendCancellationEmail } from "@/lib/email/send-appointment";

beforeEach(() => { sent.length = 0; reads.calls.length = 0; reads.mode = "preferred"; vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://hone.example"); });
afterEach(() => vi.unstubAllEnvs());

const STUDIO = { id: "studio-1", name: "Test Studio", slug: "test-studio", timezone: "America/Toronto", owner_email: "owner@studio.test", address: null, send_confirmation_emails: true, show_treatment_time_to_clients: false } as never;
const APPT = { id: "appt-1", client_id: "client-1", studio_id: "studio-1", starts_at: "2026-12-01T15:00:00Z", ends_at: "2026-12-01T16:00:00Z", duration_minutes: 60 } as never;
const body = () => JSON.stringify(sent[0] ?? {}) + "\n" + Buffer.from(((sent[0]?.attachments as { content: Buffer }[] | undefined)?.[0]?.content) ?? "").toString("utf8");

describe("the loaders", () => {
  it("return the preferred name, else the stored name; never throw", async () => {
    expect(await loadCommunicationName((await import("@/lib/supabase/admin-server")).createAdminClient(), "s", "c", "Quillon Sentinel")).toBe("Fern");
    reads.mode = "none";
    expect(await loadCommunicationName((await import("@/lib/supabase/admin-server")).createAdminClient(), "s", "c", "Quillon Sentinel")).toBe("Quillon Sentinel");
    reads.mode = "error";
    expect(await loadCommunicationName((await import("@/lib/supabase/admin-server")).createAdminClient(), "s", "c", "Quillon Sentinel")).toBe("Quillon Sentinel");
    expect(await loadCommunicationName({}, "s", "c", "Quillon Sentinel")).toBe("Quillon Sentinel");
    expect(await loadCommunicationName({}, "s", null, "Quillon Sentinel")).toBe("Quillon Sentinel");
  });
  it("a slow read is bounded: the stored name comes back", async () => {
    reads.mode = "hang";
    const admin = (await import("@/lib/supabase/admin-server")).createAdminClient();
    expect(await loadCommunicationName(admin, "s", "c", "Quillon Sentinel", 20)).toBe("Quillon Sentinel");
    expect(await loadCommunicationNameForAppointment(admin, "s", "a", "Quillon Sentinel", 20)).toBe("Quillon Sentinel");
  });
  it("the appointment loader keeps a null name null and falls back on a missing column", async () => {
    const admin = (await import("@/lib/supabase/admin-server")).createAdminClient();
    expect(await loadCommunicationNameForAppointment(admin, "s", "a", null)).toBeNull();
    reads.mode = "missing-column";
    expect(await loadCommunicationNameForAppointment(admin, "s", "a", "Quillon Sentinel")).toBe("Quillon Sentinel");
  });
});

describe("the senders, rendered (a captured transport; nothing is sent)", () => {
  const confirm = () => sendBookingConfirmationToClient({ appointment: APPT, service: null, studio: STUDIO, practitionerDisplayName: null, clientName: "Quillon Sentinel", clientEmail: "client@harness.local", cancellationUrl: "https://x.test/c", rescheduleUrl: null, intakeUrl: null, treatmentTimeLine: null, appBaseUrl: "https://hone.example" } as never);
  const notify = () => sendBookingNotificationToPractitioner({ appointment: APPT, service: null, studio: STUDIO, practitionerName: "Pat", practitionerEmail: "pat@studio.test", clientName: "Quillon Sentinel", clientEmail: "client@harness.local", clientPhone: null, notes: null, appointmentUrl: "https://x.test/cal", referralSourceLabel: null } as never);
  const cancel = () => sendCancellationEmail({ to: "pat@studio.test", recipientName: "Pat", clientName: "Quillon Sentinel", studio: STUDIO, serviceName: "Session", durationMinutes: 60, startsAt: new Date("2026-12-01T15:00:00Z"), actorName: null, actorRole: "system", reason: null, isClient: false, appointmentId: "appt-1" } as never);

  it("the calendar invite names the attendee by the communication name", async () => {
    await confirm();
    expect(body()).toMatch(/ATTENDEE;[^\n]*CN=Fern/);
    expect(body()).not.toContain("CN=Quillon");
  });
  it("the practitioner new-booking email names the client by the communication name (HTML and text)", async () => {
    await notify();
    const p = sent[0] as { html: string; text: string };
    expect(p.html).toContain("<strong>Fern</strong>");
    expect(p.text).toContain("\nFern\n");
    expect(JSON.stringify(p)).not.toContain("Quillon");
  });
  it("the cancellation email's Client row uses the communication name", async () => {
    await cancel();
    expect((sent[0] as { text: string }).text).toMatch(/Client:?\s*Fern/);
    expect(JSON.stringify(sent[0])).not.toContain("Quillon");
  });
  for (const mode of ["none", "missing-column", "error", "throw", "hang"] as const) {
    it(`with the read ${mode}: today's stored name, and the send still happens`, async () => {
      reads.mode = mode;
      vi.useFakeTimers();
      const run = async () => { const a = confirm(); const b = notify(); const c = cancel(); await vi.advanceTimersByTimeAsync(3000); return Promise.all([a, b, c]); };
      const results = await run();
      vi.useRealTimers();
      expect(results.every((r) => (r as { ok?: boolean } | undefined)?.ok !== false)).toBe(true);
      expect(sent.length).toBe(3);
      expect(sent.every((m) => JSON.stringify(m).includes("Quillon Sentinel") || Buffer.from(((m.attachments as { content: Buffer }[])?.[0]?.content) ?? "").toString().includes("Quillon"))).toBe(true);
      expect(sent.every((m) => !JSON.stringify(m).includes("Fern"))).toBe(true);
    });
  }
});

// ---- the census: every email template, and what it does with a client name -------------------------------------------------------------
const NAME_IDS = /\b(clientName|clientFirstName|recipientName|inviteeDisplayName|ownerDisplayName|firstName|greeting|customerName)\b/g;
type Rule = { kind: "no-name" | "type-only" | "staff-or-prospect" | "rendered-via-sender" | "greeting-via-communication-name"; mentions: number; note: string };
const RULES: Record<string, Rule> = {
  "appointment.ts": { kind: "rendered-via-sender", mentions: 9, note: "client confirmation: type-only; practitioner new-booking and cancellation Client row render clientName; the senders load the communication name" },
  "intake-reminder.ts": { kind: "no-name", mentions: 0, note: "names the studio only" },
  "intake-request.ts": { kind: "no-name", mentions: 0, note: "names the studio only" },
  "invitation.ts": { kind: "staff-or-prospect", mentions: 3, note: "a staff invitee, not a client" },
  "new-client-waitlist.ts": { kind: "staff-or-prospect", mentions: 0, note: "a prospect's typed name; there is no client row and no preferred name" },
  "payment-receipt.ts": { kind: "greeting-via-communication-name", mentions: 5, note: "the greeting comes from the receipt document, built with clientCommunicationName" },
  "portal-magic-link.ts": { kind: "no-name", mentions: 0, note: "a greeting that names the studio, no client name" },
  "portal-message-notification.ts": { kind: "no-name", mentions: 0, note: "" },
  "portal-reply-notification.ts": { kind: "no-name", mentions: 0, note: "" },
  "postcare.ts": { kind: "type-only", mentions: 1, note: "clientName is a type field; the template renders no client name (pinned by the preview-name test)" },
  "reminders.ts": { kind: "type-only", mentions: 2, note: "clientName is a type field in two builders; neither renders it" },
  "waitlist-decline-owner.ts": { kind: "no-name", mentions: 0, note: "" },
  "waitlist-invitation.ts": { kind: "staff-or-prospect", mentions: 0, note: "a prospect, studio-named" },
  "waitlist-recipient-proof.ts": { kind: "staff-or-prospect", mentions: 0, note: "a prospect, studio-named" },
  "welcome.ts": { kind: "staff-or-prospect", mentions: 2, note: "the studio owner, not a client" },
};
const DIR = "lib/email/templates";
const code = (p: string) => readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("census of the email templates", () => {
  it("every template is recorded, so a new one needs a decision", () => {
    expect(readdirSync(DIR).filter((f) => f.endsWith(".ts")).sort()).toEqual(Object.keys(RULES).sort());
  });
  it("each template's client-name mentions are exactly the recorded count (a new rendering of a name fails here)", () => {
    for (const [f, rule] of Object.entries(RULES)) {
      const n = (code(`${DIR}/${f}`).match(NAME_IDS) ?? []).length;
      expect(n, `${f}: ${rule.note}`).toBe(rule.mentions);
    }
  });
  it('"no-name" and "type-only" templates render no client name: the identifier appears only in type declarations', () => {
    for (const [f, rule] of Object.entries(RULES)) {
      if (rule.kind !== "no-name" && rule.kind !== "type-only") continue;
      const lines = code(`${DIR}/${f}`).split("\n").filter((l) => NAME_IDS.test(l) && (NAME_IDS.lastIndex = 0, true));
      for (const l of lines) expect(l, `${f} renders a name: ${l.trim()}`).toMatch(/^\s*\w+\??:\s*(string|string \| null);?\s*$/);
    }
  });
  it("the one template that renders a client name (appointment.ts) is fed the communication name by every sender", () => {
    const send = code("lib/email/send-appointment.ts");
    expect(send).toContain("clientName: await communicationNameAtSendBoundary(params.studio.id, params.appointment.client_id, params.clientName),");
    expect(send).toContain("clientName: await communicationNameForAppointmentAtSendBoundary(params.studio.id, params.appointmentId, params.clientName),");
    expect(send).toContain("attendeeName,");
    expect(send).not.toMatch(/attendeeName: params\.clientName/);
  });
  it("the receipt greeting is the communication name", () => {
    expect(code("lib/billing/payment-receipt.ts")).toContain("clientCommunicationName(");
  });
});
