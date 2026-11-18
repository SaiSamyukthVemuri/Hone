import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildPostcareEmail } from "@/lib/email/templates/postcare";

// HON-58: the appointment page shows the display name on screen, but a client communication preview must show what the send
// action will send. The postcare send re-reads the client and greets with the STORED name, so the preview is given the stored
// name, captured before the display name replaces it. These tests pin both ends and prove that, with the same name, the
// preview and the send build the same email.

const page = readFileSync("app/(app)/calendar/[id]/page.tsx", "utf8");
const actions = readFileSync("app/(app)/calendar/actions.ts", "utf8");
const send = readFileSync("lib/email/send-appointment.ts", "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

describe("postcare preview and send use the same name", () => {
  it("the page captures the stored name before the display name replaces it, and gives only that to the preview", () => {
    const body = code(page);
    const captured = body.indexOf("const storedClientName = data.client?.name");
    const replaced = body.indexOf("data.client = { ...rest, name: clientDisplayName(");
    expect(captured).toBeGreaterThan(0);
    expect(replaced).toBeGreaterThan(captured);
    expect(body).toMatch(/<PostcareSection[\s\S]*?clientName=\{storedClientName\}/);
    expect(body, "no communication preview is handed the display name").not.toMatch(/<PostcareSection[\s\S]*?clientName=\{data\.client/);
  });
  it("the move dialog and the briefing card, which are screen labels, keep the display name", () => {
    expect(code(page)).toMatch(/clientName: data\.client\?\.name \?\? null/);
  });
  it("the send action reads the stored name and hands it to the same builder the preview uses", () => {
    expect(actions).toMatch(/client:clients\(id, name, email\)/);
    expect(actions).toMatch(/clientName: client\.name \?\? ""/);
    expect(send).toMatch(/buildPostcareEmail\(\{[\s\S]*?clientName: params\.clientName/);
  });
  it("the postcare email does not render the client's name today, so a preview and a send cannot differ by name", () => {
    const common = {
      studioName: "Synthetic Studio", studioEmail: null, practitionerName: null, serviceName: "Synthetic service",
      startsAt: new Date("2026-10-20T15:00:00Z"), timezone: "America/Toronto", aftercareText: "Synthetic aftercare",
      warningSignsText: null, productRecommendationsText: null, reviewUrl: null, reviewPromptText: null, bookingReference: "ABC123",
    } as Parameters<typeof buildPostcareEmail>[0];
    const withStored = buildPostcareEmail({ ...common, clientName: "Stored-Sentinel-Quill" });
    const withDisplay = buildPostcareEmail({ ...common, clientName: "Preferred-Sentinel-Fern" });
    // If the template ever adds a greeting, these two stop being equal and the wiring pins above are what keep preview and send aligned.
    expect(withStored.subject).toBe(withDisplay.subject);
    expect(withStored.text).toBe(withDisplay.text);
    expect(withStored.html).toBe(withDisplay.html);
    for (const sentinel of ["Stored-Sentinel-Quill", "Preferred-Sentinel-Fern"]) {
      expect(withStored.text + withStored.html + withStored.subject).not.toContain(sentinel);
    }
  });
});
