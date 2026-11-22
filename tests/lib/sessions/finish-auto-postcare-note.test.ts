import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTO_POSTCARE_NOTE, autoPostcareNote } from "@/lib/sessions/finish-appointment";
import { shouldAutoSendPostcare } from "@/app/(app)/calendar/postcare-auto-send";

// HON-45: an opted-in studio's automatic postcare is honoured AND announced beforehand, but only when the automatic send would
// actually go out. Otherwise the line says it will not, and points at the manual button. The eligibility used here is the REAL
// predicate the send uses (shouldAutoSendPostcare), asked with the status Finish will produce: it is not re-implemented in the test.
const base = { deliveryMode: "auto_on_complete", status: "completed", serviceModality: "electrolysis", clientEmail: "c@example.com", aftercareText: "Ice it." };
const eligibility = (over: Partial<typeof base> = {}) => shouldAutoSendPostcare({ ...base, ...over });
const line = (over: Partial<typeof base> = {}, kind: Parameters<typeof autoPostcareNote>[1] = "ready") =>
  autoPostcareNote(over.deliveryMode ?? base.deliveryMode, kind, eligibility(over));

describe("autoPostcareNote: opted-in studio, per case", () => {
  it("ELIGIBLE: promises the automatic send", () => {
    expect(eligibility().ok).toBe(true);
    expect(line()).toBe(AUTO_POSTCARE_NOTE);
    expect(line({}, "before_start")).toBe(AUTO_POSTCARE_NOTE);
  });

  it("CONSULTATION: no promise; says it is not sent automatically and to use Send postcare", () => {
    const l = line({ serviceModality: "consultation" })!;
    expect(l).not.toMatch(/will be sent automatically/);
    expect(l).toMatch(/isn't sent automatically for this visit: it is a consultation/);
    expect(l).toMatch(/Use Send postcare after finishing/);
    expect(l).toMatch(/Charging is separate/);
  });

  it("NO EMAIL on file (missing, empty or blank): no promise", () => {
    for (const clientEmail of [null, "", "   "]) {
      const l = line({ clientEmail: clientEmail as string })!;
      expect(l, String(clientEmail)).not.toMatch(/will be sent automatically/);
      expect(l).toMatch(/no email address on file/);
      expect(l).toMatch(/Use Send postcare after finishing/);
    }
  });

  it("AFTERCARE NOT CONFIGURED (missing, empty or blank): no promise", () => {
    for (const aftercareText of [null, "", "  \n "]) {
      const l = line({ aftercareText: aftercareText as string })!;
      expect(l, String(aftercareText)).not.toMatch(/will be sent automatically/);
      expect(l).toMatch(/no aftercare text is set/);
      expect(l).toMatch(/Use Send postcare after finishing/);
    }
  });

  it("the line and the real send agree for every combination: promise exactly when the predicate says ok", () => {
    for (const serviceModality of ["electrolysis", "consultation", null])
      for (const clientEmail of ["c@example.com", null, ""])
        for (const aftercareText of ["Ice it.", null, " "]) {
          const over = { serviceModality: serviceModality as string, clientEmail: clientEmail as string, aftercareText: aftercareText as string };
          const promised = line(over) === AUTO_POSTCARE_NOTE;
          expect(promised, JSON.stringify(over)).toBe(eligibility(over).ok);
        }
  });

  it("the promise names postcare, calls it a studio setting, and says charging is separate", () => {
    expect(AUTO_POSTCARE_NOTE).toMatch(/Postcare will be sent automatically/);
    expect(AUTO_POSTCARE_NOTE).toMatch(/studio setting/);
    expect(AUTO_POSTCARE_NOTE).toMatch(/Charging is separate/);
  });
});

describe("autoPostcareNote: everyone else, and nothing left to complete", () => {
  it("manual, unset or unknown mode: never shown, eligible or not", () => {
    for (const mode of ["manual", null, undefined, "", "AUTO_ON_COMPLETE", "auto"]) {
      expect(autoPostcareNote(mode, "ready", { ok: true }), String(mode)).toBeNull();
      expect(autoPostcareNote(mode, "ready", { ok: false, reason: "skipped_no_email" }), String(mode)).toBeNull();
    }
  });

  it("not shown once there is nothing left to complete", () => {
    for (const kind of ["completed", "cancelled", "no_show", "unlinked"] as const) {
      expect(autoPostcareNote("auto_on_complete", kind, { ok: true }), kind).toBeNull();
    }
  });
});

describe("the session page asks the real predicate, not a copy", () => {
  const page = readFileSync(join(__dirname, "../../../app/(app)/clients/[id]/sessions/[sessionId]/page.tsx"), "utf8");
  it("calls shouldAutoSendPostcare with the status Finish will produce and passes its answer to the presenter", () => {
    expect(page).toMatch(/import \{ shouldAutoSendPostcare \} from "@\/app\/\(app\)\/calendar\/postcare-auto-send";/);
    expect(page).toMatch(/const eligibility = shouldAutoSendPostcare\(\{[\s\S]*?status: "completed"[\s\S]*?\}\);/);
    expect(page).toMatch(/autoPostcareNote\(studio\.postcare_delivery_mode, finishState\.completion\.kind, eligibility\)/);
  });
  it("feeds it EXACTLY the appointment's modality, the client's email and the studio's aftercare text: no literal, no other source", () => {
    // Anchored on the call itself: a bare "serviceModality: finishAppt?.serviceModality" appears elsewhere in the page, so an unanchored
    // match would stay green when THIS call passes null or a made-up address.
    const m = /const eligibility = shouldAutoSendPostcare\(\{([\s\S]*?)\}\);/.exec(page);
    expect(m).not.toBeNull();
    const props = m![1].split("\n").map((l) => l.trim()).filter(Boolean);
    expect(props).toEqual([
      "deliveryMode: studio.postcare_delivery_mode,",
      'status: "completed",',
      "serviceModality: finishAppt?.serviceModality ?? null,",
      "clientEmail: clientData.client.email ?? null,",
      "aftercareText: studio.postcare_aftercare_text,",
    ]);
  });
  it("finishAppt.serviceModality itself comes from the appointment's own service, not a constant", () => {
    expect(page).toMatch(/serviceModality: svcOne\?\.modality \?\? null,/);
  });
});
