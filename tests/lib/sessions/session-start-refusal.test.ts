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

  it("names the assigned practitioner and the real recovery (owner Move), never a raw error", () => {
    const c = sessionStartRefusalCopy("assigned_elsewhere", "SYNTH-FETT Electrologist 2");
    expect(c.title).toBe("This appointment is booked with SYNTH-FETT Electrologist 2");
    expect(c.body).toMatch(/Only SYNTH-FETT Electrologist 2 can start the chart/);
    expect(c.body).toMatch(/studio owner can first reassign it to you with Move/);
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
    // The pre-check is studio-scoped and compares against the SIGNED-IN practitioner.
    expect(PAGE).toMatch(/\.eq\("studio_id", studio\.id\)/);
    expect(PAGE).toMatch(/appt\.practitioner_id !== practitioner\.id/);
  });
});
