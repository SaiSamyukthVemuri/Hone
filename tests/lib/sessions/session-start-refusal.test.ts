import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SESSION_START_REFUSALS,
  parseSessionStartRefusal,
  classifyAppointmentForStart,
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
    expect(PAGE).toMatch(/classifyAppointmentForStart\(appt as StartAppointmentLookup \| null, \{ studioId: studio\.id, clientId: id, practitionerId: practitioner\.id \}\)/);
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
    // A FAILED check is not a missing appointment: no unlinked-session offer, a retry instead.
    expect(PAGE).toMatch(/if \(apptErr\) \{[\s\S]{0,600}refusal = "check_failed";/);
    expect(PAGE).not.toMatch(/if \(apptErr\) \{[\s\S]{0,600}refusal = "appointment_missing";\s*\} else if \(!appt\)/);
    expect(PAGE).toMatch(/refusal === "check_failed" && appointmentId && \([\s\S]{0,300}Try again/);
    const failed = sessionStartRefusalCopy("check_failed", null);
    expect(failed.body).toMatch(/Reload the page to try again/);
    expect(failed.body).not.toMatch(/without/i);
    // The page offers a link to the appointment (where Move appears only when
    // usable) and no predicate of its own about reassignment.
    expect(PAGE).toMatch(/href=\{`\/calendar\/\$\{appointmentId\}`\}/);
    expect(PAGE).not.toMatch(/canReassign/);
    // EVERY lineage failure is shown before the picker, matching the action's refusals.
    // (decided by the ONE shared classifier; its unit tests above prove each code)
    expect(PAGE).toMatch(/refusal = decided\.refusal;/);
    // A missing or foreign appointment never gets a dead /calendar/<id> link.
    expect(PAGE).toMatch(
      /const appointmentLinkable =\s*!!appointmentId && refusal !== "appointment_missing";/,
    );
    expect(PAGE).toMatch(/\{appointmentLinkable \? \(\s*<Link href=\{`\/calendar\/\$\{appointmentId\}`\}/);
    // The copy's "start a session without an appointment" recovery is a real link.
    expect(PAGE).toMatch(/offerUnlinkedStart && \([\s\S]{0,300}href=\{`\/clients\/\$\{id\}\/sessions\/new`\}/);
  });
});

describe("no existence oracle: another studio's or an unseen appointment answers EXACTLY like a nonexistent id", () => {
  const ctx = { studioId: "studio", clientId: "client", practitionerId: "me" };
  const same = { studio_id: "studio", client_id: "client", practitioner_id: "colleague", practitioner: { display_name: "Colleague Name", active: true } };

  it("a nonexistent/unseen appointment, and one in ANOTHER studio, give the identical decision (code, no name)", () => {
    const missing = classifyAppointmentForStart(null, ctx);
    const otherStudio = classifyAppointmentForStart({ ...same, studio_id: "someone-elses-studio" }, ctx);
    expect(otherStudio).toEqual(missing);
    expect(missing).toEqual({ refusal: "appointment_missing", assignedName: null, assigneeInactive: false });
  });

  it("the other studio's practitioner name and ids never reach the decision, even when the row carries them", () => {
    const d = classifyAppointmentForStart({ ...same, studio_id: "someone-elses-studio", client_id: "other-client" }, ctx);
    expect(JSON.stringify(d)).not.toMatch(/Colleague Name|someone-elses-studio|other-client|colleague/);
  });

  it("the copy for both is the same words, with no name and no time", () => {
    const a = sessionStartRefusalCopy(classifyAppointmentForStart(null, ctx).refusal!, null);
    const b = sessionStartRefusalCopy(classifyAppointmentForStart({ ...same, studio_id: "x" }, ctx).refusal!, null);
    expect(b).toEqual(a);
    expect(JSON.stringify(a)).not.toMatch(/\d{1,2}:\d{2}|Colleague/);
  });

  it("the redirect (action side) is byte-identical for nonexistent, not-visible and other-studio ids", () => {
    const href = (id: string) => sessionStartRefusalHref("client", id, classifyAppointmentForStart(null, ctx).refusal!);
    const other = (id: string) => sessionStartRefusalHref("client", id, classifyAppointmentForStart({ ...same, studio_id: "x" }, ctx).refusal!);
    expect(other("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(href("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
  });

  it("only an appointment in THIS studio may say more: another client's, or a colleague's (the name appears only then)", () => {
    expect(classifyAppointmentForStart({ ...same, client_id: "other" }, ctx).refusal).toBe("other_client");
    const d = classifyAppointmentForStart(same, ctx);
    expect(d.refusal).toBe("assigned_elsewhere");
    expect(d.assignedName).toBe("Colleague Name");
  });

  it("'other_studio' no longer exists as a code or a copy branch", () => {
    expect((SESSION_START_REFUSALS as readonly string[]).includes("other_studio")).toBe(false);
    expect(parseSessionStartRefusal("other_studio")).toBeNull();
  });
});
