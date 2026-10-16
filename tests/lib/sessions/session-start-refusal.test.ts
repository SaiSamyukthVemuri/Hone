import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SESSION_START_REFUSALS,
  parseSessionStartRefusal,
  sessionStartRefusalCopy,
  sessionStartRefusalHref,
} from "@/lib/sessions/session-start-refusal";

const PAGE = readFileSync(
  path.resolve(__dirname, "../../../app/(app)/clients/[id]/sessions/new/page.tsx"),
  "utf8",
);

describe("session-start refusals (a booking assigned to a colleague is SAID, not thrown)", () => {
  it("parses only known codes; anything else is no refusal", () => {
    for (const code of SESSION_START_REFUSALS) expect(parseSessionStartRefusal(code)).toBe(code);
    expect(parseSessionStartRefusal("assigned_elsewhere ")).toBeNull();
    expect(parseSessionStartRefusal("<script>")).toBeNull();
    expect(parseSessionStartRefusal(undefined)).toBeNull();
    expect(parseSessionStartRefusal(["assigned_elsewhere"])).toBeNull();
  });

  it("names the assigned practitioner and only the recovery that ALWAYS exists", () => {
    const c = sessionStartRefusalCopy("assigned_elsewhere", "SYNTH-FETT Electrologist 2");
    expect(c.title).toBe("This appointment is booked with SYNTH-FETT Electrologist 2");
    expect(c.body).toMatch(/Only SYNTH-FETT Electrologist 2 can start the chart/);
    expect(c.body).toMatch(/Ask SYNTH-FETT Electrologist 2 to open it and start the chart/);
    // Never promises reassignment: whether Move can reassign depends on status,
    // time, the studio's capacity/booking flags and service eligibility, which
    // only the calendar's Move flow knows. Promising it drifted three times.
    for (const code of SESSION_START_REFUSALS) {
      for (const assigneeInactive of [false, true]) {
        const { title, body } = sessionStartRefusalCopy(code, "X", { assigneeInactive });
        expect(`${title} ${body}`).not.toMatch(/\bMove\b|reassign/i);
      }
    }
    // A DEACTIVATED assignee can no longer chart: never "ask them"; name the
    // recovery that exists (an unlinked session), which the page links.
    const gone = sessionStartRefusalCopy("assigned_elsewhere", "SYNTH-FETT Electrologist 2", { assigneeInactive: true });
    expect(gone.title).toMatch(/no longer has access/);
    expect(gone.body).not.toMatch(/\bAsk\b/);
    expect(gone.body).toMatch(/without linking this appointment/);
    expect(sessionStartRefusalCopy("assigned_elsewhere", "  ").title).toBe(
      "This appointment is booked with another practitioner",
    );
    for (const code of SESSION_START_REFUSALS) {
      const { title, body } = sessionStartRefusalCopy(code, null);
      expect(title.length).toBeGreaterThan(10);
      expect(`${title} ${body}`).not.toMatch(/error|exception|failed/i);
    }
  });

  it("redirects back to the SAME client's new-session page, keeping the appointment", () => {
    const href = sessionStartRefusalHref("c-1", "a-2", "assigned_elsewhere");
    expect(href).toBe("/clients/c-1/sessions/new?appointment_id=a-2&refused=assigned_elsewhere");
  });

  it("the page never offers the modality picker while a refusal is shown", () => {
    expect(PAGE).toMatch(/\{!refusalCopy && <ModalityPicker clientId=\{id\} appointmentId=\{appointmentId\} \/>\}/);
    expect(PAGE).toMatch(/data-testid="session-start-refusal"/);
    // The pre-check reads the appointment as the ACTION does (membership-visible,
    // not pre-filtered to the selected studio), checks the studio itself, and
    // compares against the SIGNED-IN practitioner.
    expect(PAGE).not.toMatch(/\.eq\("studio_id", studio\.id\)/);
    expect(PAGE).toMatch(/\} else if \(appt\.studio_id !== studio\.id\) \{\s*refusal = "other_studio";/);
    expect(PAGE).toMatch(/appt\.practitioner_id !== practitioner\.id/);
    // The refusal is derived from the CURRENT row, never from the URL's `refused` code.
    expect(PAGE).not.toMatch(/parseSessionStartRefusal\(/);
    expect(PAGE).not.toMatch(/sp\.refused/);
    // An inactive assignee gets the unlinked-start recovery link.
    expect(PAGE).toMatch(
      /const offerUnlinkedStart =\s*refusal === "appointment_missing" \|\| \(refusal === "assigned_elsewhere" && assigneeInactive\);/,
    );
    // The embed names the assignment FK (bare `practitioners(` is PGRST201 since 0174),
    // and a failed pre-check never falls through to offering the picker.
    expect(PAGE).toMatch(/practitioners!appointments_practitioner_same_studio_fk\(display_name, active\)/);
    expect(PAGE).not.toMatch(/[^!]practitioners\(display_name\)/);
    expect(PAGE).toMatch(/if \(apptErr\) \{[\s\S]{0,400}refusal = "appointment_missing";/);
    // The page offers a link to the appointment (where Move appears only when
    // usable) and no predicate of its own about reassignment.
    expect(PAGE).toMatch(/href=\{`\/calendar\/\$\{appointmentId\}`\}/);
    expect(PAGE).not.toMatch(/canReassign/);
    // EVERY lineage failure is shown before the picker, matching the action's refusals.
    expect(PAGE).toMatch(/\} else if \(!appt\) \{[\s\S]{0,300}refusal = "appointment_missing";/);
    expect(PAGE).toMatch(/\} else if \(appt\.client_id !== id\) \{\s*refusal = "other_client";/);
    // A missing or foreign appointment never gets a dead /calendar/<id> link.
    expect(PAGE).toMatch(
      /const appointmentLinkable =\s*!!appointmentId && refusal !== "appointment_missing" && refusal !== "other_studio";/,
    );
    expect(PAGE).toMatch(/\{appointmentLinkable \? \(\s*<Link href=\{`\/calendar\/\$\{appointmentId\}`\}/);
    // The copy's "start a session without an appointment" recovery is a real link.
    expect(PAGE).toMatch(/offerUnlinkedStart && \([\s\S]{0,300}href=\{`\/clients\/\$\{id\}\/sessions\/new`\}/);
  });
});
