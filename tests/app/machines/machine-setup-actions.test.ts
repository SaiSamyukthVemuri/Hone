import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ===========================================================================
// MPX-03 — identity is derived on the SERVER, and ownership is never submitted.
//
// The load-bearing claim: a client cannot name which practitioner or studio a
// remembered machine belongs to, because the server entry points accept no such
// argument. That is asserted three ways here - on the exported signatures, on
// the module source, and behaviourally with a mocked session - so a later
// "convenience" parameter cannot quietly reopen it.
// ===========================================================================

const SESSION = vi.hoisted(() => ({
  current: null as null | { practitioner: { id: string }; studio: { id: string } },
}));

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => SESSION.current,
}));

const actions = await import(
  "@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions"
);

const ACTIONS_SRC = readFileSync(
  path.resolve(
    __dirname,
    "../../../app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts",
  ),
  "utf8",
);

function signIn(studioId: string, practitionerId: string) {
  SESSION.current = { practitioner: { id: practitionerId }, studio: { id: studioId } };
}

beforeEach(() => {
  SESSION.current = null;
});

// ---------------------------------------------------------------------------

describe("ownership cannot be submitted", () => {
  it("loadMachineSetupContext accepts NO arguments at all", () => {
    // Nothing to forge if there is nothing to send. This is the structural
    // form of the rule, and arity is the honest way to state it for a function
    // that genuinely takes nothing.
    expect(actions.loadMachineSetupContext.length).toBe(0);
    expect(actions.listSelectableForCaller.length).toBe(0);
  });

  it("the remember action takes the CHOICE only", () => {
    // One parameter: the device choice. No scope, no studio, no practitioner.
    expect(actions.rememberMachineSelectionAction.length).toBe(1);
  });

  it("the module never reads an ownership field out of its own input", () => {
    const code = ACTIONS_SRC.split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    // The only `studioId` it may touch is the one it derived itself, via
    // `identity()` / `scope.studioId`. A `choice.studioId` or an input-shaped
    // ownership read is the defect.
    expect(code).not.toMatch(/choice\.(studioId|practitionerId)/);
    expect(code).not.toMatch(/input\.(studioId|practitionerId)/);
    // And identity really does come from the authenticated session.
    expect(code).toContain("getCurrentPractitionerWithStudio");
  });

  it("the choice type carries no ownership field", () => {
    const sig = ACTIONS_SRC.slice(
      ACTIONS_SRC.indexOf("rememberMachineSelectionAction(choice: {"),
      ACTIONS_SRC.indexOf("}): Promise<RememberResult>"),
    );
    expect(sig).toContain("deviceId");
    expect(sig).toContain("modeKey");
    expect(sig).not.toContain("studioId");
    expect(sig).not.toContain("practitionerId");
  });
});

describe("identity comes from the session, per call", () => {
  it("an anonymous request gets no scope and no devices", async () => {
    const ctx = await actions.loadMachineSetupContext();
    expect(ctx.scope).toBeNull();
    expect(ctx.devices).toEqual([]);
    expect(ctx.remembered).toBeNull();
    expect(ctx.persistence.persisted).toBe(false);
  });

  it("an authenticated request gets ITS OWN scope, derived not supplied", async () => {
    signIn("studio-fett", "pract-sabrina");
    const ctx = await actions.loadMachineSetupContext();
    expect(ctx.scope).toEqual({
      studioId: "studio-fett",
      practitionerId: "pract-sabrina",
    });
  });

  it("switching session identity switches the scope, with no client input", async () => {
    signIn("studio-one", "pract-a");
    expect((await actions.loadMachineSetupContext()).scope).toEqual({
      studioId: "studio-one",
      practitionerId: "pract-a",
    });
    signIn("studio-two", "pract-b");
    expect((await actions.loadMachineSetupContext()).scope).toEqual({
      studioId: "studio-two",
      practitionerId: "pract-b",
    });
  });

  it("reports the inventory's own absence rather than an empty studio", async () => {
    signIn("studio-fett", "pract-sabrina");
    const ctx = await actions.loadMachineSetupContext();
    expect(ctx.devices).toEqual([]);
    expect(ctx.inventoryReason).toMatch(/no machine inventory exists in the database yet/i);
  });

  it("never claims persistence", async () => {
    signIn("studio-fett", "pract-sabrina");
    const ctx = await actions.loadMachineSetupContext();
    expect(ctx.persistence.persisted).toBe(false);
    expect(ctx.persistence.kind).toBe("none");
  });
});

describe("remembering a machine", () => {
  it("refuses an unauthenticated caller", async () => {
    const r = await actions.rememberMachineSelectionAction({
      deviceId: "room-1",
      modeKey: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unauthenticated");
  });

  it("refuses a device that is not in the caller's own inventory", async () => {
    signIn("studio-fett", "pract-sabrina");
    const r = await actions.rememberMachineSelectionAction({
      deviceId: "someone-elses-room",
      modeKey: null,
    });
    expect(r.ok).toBe(false);
    // There is no inventory at all today, so every device is unknown. The
    // refusal is the point: nothing is accepted on the client's word.
    if (!r.ok) expect(r.code).toBe("rejected");
  });

  it("keeps unsupported profiles unreachable", async () => {
    // Even naming a real catalogue profile cannot get it selected: the device
    // has to be in the studio's inventory AND on an offered profile, and no
    // profile is offered.
    signIn("studio-fett", "pract-sabrina");
    for (const id of [
      "silhouettone:evolution-st-350",
      "permanence-gemm:gemm-16",
      "dectro-apilus:xcell",
    ]) {
      const r = await actions.rememberMachineSelectionAction({
        deviceId: id,
        modeKey: null,
      });
      expect(r.ok, `${id} must not become selectable`).toBe(false);
    }
  });

  it("offers nothing to select for a real authenticated caller today", async () => {
    signIn("studio-fett", "pract-sabrina");
    expect(await actions.listSelectableForCaller()).toEqual([]);
  });

  it("offers nothing to an anonymous caller either", async () => {
    expect(await actions.listSelectableForCaller()).toEqual([]);
  });
});
