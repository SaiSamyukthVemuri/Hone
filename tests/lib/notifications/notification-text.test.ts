import { describe, expect, it } from "vitest";
import {
  buildBookedText,
  buildCancelledText,
  buildIntakeSubmittedText,
  buildRescheduledText,
} from "@/lib/notifications/notification-text";

// The builders are the ONE place a studio-facing notification's words are made. These tests assert the PROPERTY directly: the text is exactly the
// wording below, it contains the parameters it is given and no other content, and a hostile value only ever appears where its field belongs.

describe("buildBookedText", () => {
  it("builds the exact studio-facing wording", () => {
    expect(buildBookedText({ clientName: "Kit", serviceName: "Consultation", dayLabel: "Tue, 1 Dec", timeLabel: "5:00 PM" })).toEqual({
      title: "New booking",
      body: "Kit booked Consultation for Tue, 1 Dec at 5:00 PM.",
    });
  });
});

describe("buildRescheduledText", () => {
  it("names the client and both times", () => {
    expect(buildRescheduledText({ clientName: "Kit", fromLabel: "Tue 5:00 PM", toLabel: "Wed 9:00 AM" })).toEqual({
      title: "Appointment rescheduled",
      body: "Kit rescheduled from Tue 5:00 PM to Wed 9:00 AM.",
    });
  });
});

describe("buildIntakeSubmittedText", () => {
  it("names the client when there is a name", () => {
    expect(buildIntakeSubmittedText({ clientName: "Kit" })).toEqual({ title: "Intake submitted", body: "Kit submitted an intake form." });
  });
  it.each([null, "", "   "])("keeps the generic wording for a missing name (%j)", (clientName) => {
    expect(buildIntakeSubmittedText({ clientName }).body).toBe("A client submitted an intake form.");
  });
  it("carries nothing but the name: its output is the name plus fixed words", () => {
    const out = buildIntakeSubmittedText({ clientName: "Kit" });
    expect(out.body.replace("Kit", "")).toBe(" submitted an intake form.");
  });
});

describe("buildCancelledText", () => {
  const when = { dayLabel: "Tue, 1 Dec", timeLabel: "5:00 PM" };
  const base = { staffName: null, byStaff: false, clientName: "Kit" as string | null, serviceName: "Consultation", when, reasonLabel: null as string | null };

  it("a client's own cancel names the client", () => {
    expect(buildCancelledText(base)).toEqual({ title: "Appointment cancelled", body: "Kit cancelled Consultation on Tue, 1 Dec at 5:00 PM." });
  });
  it("a client's own cancel with no name is generic", () => {
    expect(buildCancelledText({ ...base, clientName: null }).body).toBe("A client cancelled Consultation on Tue, 1 Dec at 5:00 PM.");
  });
  it("a staff cancel names the staff member, the client and the service", () => {
    expect(buildCancelledText({ ...base, byStaff: true, staffName: "Dana" }).body).toBe("Dana cancelled Kit's Consultation on Tue, 1 Dec at 5:00 PM.");
  });
  it.each([null, undefined, ""])("a staff cancel with no staff name reads 'A team member' (%j)", (staffName) => {
    expect(buildCancelledText({ ...base, byStaff: true, staffName }).body).toBe("A team member cancelled Kit's Consultation on Tue, 1 Dec at 5:00 PM.");
  });
  it("a staff cancel with no client name says 'a client's'", () => {
    expect(buildCancelledText({ ...base, byStaff: true, staffName: "Dana", clientName: null }).body).toBe("Dana cancelled a client's Consultation on Tue, 1 Dec at 5:00 PM.");
  });
  it("no known time leaves the time out, and a reason is appended", () => {
    expect(buildCancelledText({ ...base, when: null, reasonLabel: "Illness" }).body).toBe("Kit cancelled Consultation. Reason: Illness.");
  });
  it("an empty reason adds nothing", () => {
    expect(buildCancelledText({ ...base, reasonLabel: "" }).body).toBe("Kit cancelled Consultation on Tue, 1 Dec at 5:00 PM.");
  });
});

describe("the builders add no content of their own", () => {
  // Each output, with every parameter value removed, must be fixed words only: a field that sneaks in (a note, an address, an id) would survive.
  const SENTINELS = { a: "ZZA", b: "ZZB", c: "ZZC", d: "ZZD" };
  const strip = (text: string) => Object.values(SENTINELS).reduce((t, v) => t.split(v).join(""), text);

  it("booked", () => {
    const { body } = buildBookedText({ clientName: SENTINELS.a, serviceName: SENTINELS.b, dayLabel: SENTINELS.c, timeLabel: SENTINELS.d });
    expect(strip(body)).toBe(" booked  for  at .");
  });
  it("rescheduled", () => {
    const { body } = buildRescheduledText({ clientName: SENTINELS.a, fromLabel: SENTINELS.b, toLabel: SENTINELS.c });
    expect(strip(body)).toBe(" rescheduled from  to .");
  });
  it("cancelled by a client and by staff", () => {
    const common = { clientName: SENTINELS.a, serviceName: SENTINELS.b, when: { dayLabel: SENTINELS.c, timeLabel: SENTINELS.d }, reasonLabel: null };
    expect(strip(buildCancelledText({ ...common, byStaff: false, staffName: null }).body)).toBe(" cancelled  on  at .");
    expect(strip(buildCancelledText({ ...common, byStaff: true, staffName: "ZZE" }).body.replace("ZZE", ""))).toBe(" cancelled 's  on  at .");
  });
  it("a value containing another field's markup is carried as plain text and never re-interpreted", () => {
    const { body } = buildBookedText({ clientName: "${serviceName}", serviceName: "<b>x</b>", dayLabel: "${0}", timeLabel: "{{t}}" });
    expect(body).toBe("${serviceName} booked <b>x</b> for ${0} at {{t}}.");
  });
});
