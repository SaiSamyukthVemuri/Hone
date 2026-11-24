import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AdmissionActions } from "@/components/waitlist/admission-row";
import { CANCEL_CAN_BE_RETURNED, RETURN_TO_WAITLIST_NOTE, type AdapterCapabilities } from "@/lib/waitlist/invite-to-book-contract";

// The exit controls say where the person goes and how to undo it. The sentences are pinned word for word, and they promise NO retention period:
// how long anything is kept is not decided, so a day count here would be an invented fact.
const CONNECTED: AdapterCapabilities = { enforcesScope: true, canResend: true, canCancel: true, canReturnToWaitlist: true, canRemove: true };
const html = (status: "released" | "expired" | "invited") =>
  renderToStaticMarkup(AdmissionActions({ entryId: "e1", entryName: "Sarah Jones", status, context: { invitationElapsed: false, invitationRedeemed: false }, capabilities: CONNECTED }) as never);

describe("exit wording", () => {
  it("pins the two sentences", () => {
    expect(RETURN_TO_WAITLIST_NOTE).toBe("Puts them back in the waiting queue with the date they first joined.");
    expect(CANCEL_CAN_BE_RETURNED).toBe("You can return them to the waitlist; they keep the date they first joined.");
  });
  it("Return to waitlist shows its sentence on a released and on an expired entry", () => {
    for (const s of ["released", "expired"] as const) expect(html(s)).toContain(RETURN_TO_WAITLIST_NOTE);
  });
  it("Cancel invitation's confirmation names the destination and the way back", () => {
    const h = html("invited");
    expect(h).toContain("The booking link stops working straight away.");
    expect(h).toContain("set aside");
    expect(h).toContain(CANCEL_CAN_BE_RETURNED);
  });
  it("no exit sentence promises an open-ended return or keeping: not \"at any time\", \"always\", \"forever\" or \"indefinitely\"", () => {
    expect(CANCEL_CAN_BE_RETURNED).not.toMatch(/at any time|always|forever|indefinite/i);
    expect(RETURN_TO_WAITLIST_NOTE).not.toMatch(/at any time|always|forever|indefinite/i);
    for (const s of ["released", "expired", "invited"] as const) expect(html(s).replace(/<[^>]+>/g, " ")).not.toMatch(/at any time|forever|indefinite/i);
  });
  it("no exit sentence states a number of days or months", () => {
    for (const s of ["released", "expired", "invited"] as const) {
      const text = html(s).replace(/<[^>]+>/g, " ");
      expect(text).not.toMatch(/\b\d+\s*(day|days|week|weeks|month|months)\b/i);
    }
    const src = readFileSync("lib/waitlist/invite-to-book-contract.ts", "utf8");
    for (const c of ["RETURN_TO_WAITLIST_NOTE", "CANCEL_CAN_BE_RETURNED"]) {
      const line = src.split("\n").find((l) => l.startsWith(`export const ${c}`));
      expect(line).toBeDefined();
    }
  });
});
