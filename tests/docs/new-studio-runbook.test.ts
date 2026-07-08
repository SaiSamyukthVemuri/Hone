import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #224. Pins for the internal new-studio setup runbook. Docs-only
// PR; these pins keep the safety-critical content of the runbook
// from eroding (the do-not-touch list, the invite-only account path,
// the delete-hardening-respecting cleanup, and the payments posture).

const RUNBOOK = readFileSync(
  path.resolve(__dirname, "../..", "docs/20_NEW_STUDIO_SETUP_RUNBOOK.md"),
  "utf8",
);

describe("runbook framing", () => {
  it("is explicitly internal, not a user-facing onboarding surface", () => {
    expect(RUNBOOK).toMatch(/INTERNAL operator checklist/);
    expect(RUNBOOK).toMatch(/NOT user-facing documentation, NOT an onboarding feature/);
  });

  it("carries the production-write approval discipline", () => {
    expect(RUNBOOK).toMatch(
      /production WRITES require the exact SQL to be shown and explicitly approved/,
    );
    expect(RUNBOOK).toMatch(/supabase db query --linked/);
  });
});

describe("account path is the invite flow", () => {
  it("uses pending_invitations + handle_new_user, never hand-inserted practitioners", () => {
    expect(RUNBOOK).toMatch(/insert into public\.pending_invitations/);
    expect(RUNBOOK).toMatch(/handle_new_user/);
    expect(RUNBOOK).toMatch(
      /Never insert a practitioners row by hand for a real person/,
    );
  });

  it("the owner invitation uses role 'owner'", () => {
    expect(RUNBOOK).toMatch(/'owner', '<OWNER DISPLAY NAME>'/);
  });
});

describe("safety content", () => {
  it("do-not-touch list covers the non-negotiables", () => {
    expect(RUNBOOK).toMatch(/Do not (enable|flip) live payments/);
    expect(RUNBOOK).toMatch(/Do not use the production service role casually\./);
    expect(RUNBOOK).toMatch(/Do not alter RLS policies\./);
    expect(RUNBOOK).toMatch(/Do not touch Willow data\./);
    expect(RUNBOOK).toMatch(
      /Do not invite a second practitioner into ANY studio without the exposure-incident access review\./,
    );
    expect(RUNBOOK).toMatch(/Do not run migrations/);
  });

  it("isolation checks exist at both app and DB level", () => {
    expect(RUNBOOK).toMatch(/show ZERO Willow data/);
    expect(RUNBOOK).toMatch(/Willow surfaces show ZERO Laura data/);
    expect(RUNBOOK).toMatch(/cross-studio leakage probes/);
  });

  it("smoke cleanup respects the clinical delete hardening", () => {
    expect(RUNBOOK).toMatch(/WITHOUT violating the clinical delete hardening/);
    expect(RUNBOOK).toMatch(/\*\*Archive\*\* the ZZ TEST client/);
    expect(RUNBOOK).toMatch(/Do NOT hand-delete anything by SQL\./);
    expect(RUNBOOK).toMatch(/append-only, by design/);
  });

  it("payments posture is explicit: new studio test-mode; supervised live for approved studios", () => {
    // A new studio starts in test mode and is enabled per-studio only after supervised approval...
    expect(RUNBOOK).toMatch(/new studio starts in\s*\**\s*test\s*mode|starts test-mode|stays test-mode|is test-mode/i);
    // ...but supervised live session payments ARE already live for approved studios.
    expect(RUNBOOK).toMatch(/supervised live[\s\S]{0,60}session[\s\S]{0,40}payments are (already )?live for approved studios/i);
    expect(RUNBOOK).toMatch(/do not (flip|enable) live/i);
  });

  it("machine frequency is documented as sticky-learned, not SQL-set", () => {
    expect(RUNBOOK).toMatch(/do not set by SQL/);
  });
});
