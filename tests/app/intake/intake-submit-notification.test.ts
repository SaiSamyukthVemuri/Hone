import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// In-app notification on intake submit. When a client successfully submits
// their intake form, submitIntakeAction fires a fire-and-forget
// recordPractitionerNotification (the PR #164 helper) so the studio sees it in
// Hone's notification center, no email, no SMS. This is a source-grep guard
// (submitIntakeAction has no direct harness; the flow mirrors the book/cancel/
// reschedule notification wiring, which are pinned the same way). It asserts
// the wiring, the once-only placement (idempotency), and the privacy posture.

const ACTIONS = readFileSync(
  path.resolve(__dirname, "../../../app/intake/[token]/actions.ts"),
  "utf8",
);
// Comment-stripped view so a doc-comment mentioning e.g. the token cannot
// satisfy or trip a privacy grep that must target real code.
const CODE = ACTIONS.split("\n")
  .filter((l) => !/^\s*\/\//.test(l))
  .join("\n");

// The submit action body (from `export async function submitIntakeAction` to
// the next top-level function), so positional assertions are scoped to it.
function submitBody(): string {
  const start = ACTIONS.indexOf("export async function submitIntakeAction");
  expect(start).toBeGreaterThan(-1);
  const after = ACTIONS.indexOf("\nasync function syncIntakeToClient", start);
  return ACTIONS.slice(start, after > -1 ? after : undefined);
}

describe("intake submit → in-app notification wiring", () => {
  it("imports the PR #164 notification helper", () => {
    expect(CODE).toMatch(
      /import \{ recordPractitionerNotification \} from "@\/lib\/notifications\/practitioner-notifications"/,
    );
  });

  it("calls recordPractitionerNotification with the intake_submitted event", () => {
    const body = submitBody();
    expect(body).toMatch(/recordPractitionerNotification\(\{/);
    expect(body).toMatch(/eventType: "intake_submitted"/);
    expect(body).toMatch(/title: "Intake submitted"/);
  });

  it("is studio-scoped with studio-wide visibility (practitionerId null)", () => {
    const body = submitBody();
    expect(body).toMatch(/studioId: existing\.studio_id/);
    expect(body).toMatch(/practitionerId: null/);
    expect(body).toMatch(/clientId: existing\.client_id/);
  });

  it("links to the authenticated intake review page (no token in the href)", () => {
    const body = submitBody();
    expect(body).toMatch(/href: `\/clients\/\$\{existing\.client_id\}\/intake`/);
    // The href must never carry the intake token.
    expect(body).not.toMatch(/href:[^\n]*token/i);
  });
});

describe("intake submit → notification is once-only (idempotent)", () => {
  it("fires only in the winner branch, AFTER the zero-rows-updated guard", () => {
    const body = submitBody();
    const guardIdx = body.indexOf("if (!updated || updated.length === 0)");
    const notifyIdx = body.indexOf("recordPractitionerNotification(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeGreaterThan(-1);
    // The notification must come after the race-loser/early-return guard so a
    // resubmit / double-click / retry (which returns before this point) never
    // double-notifies. The atomic status transition is the dedup.
    expect(notifyIdx).toBeGreaterThan(guardIdx);
  });

  it("fires only after the successful persist (after the submitted UPDATE)", () => {
    const body = submitBody();
    const updateIdx = body.indexOf('status: "submitted"');
    const notifyIdx = body.indexOf("recordPractitionerNotification(");
    expect(updateIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeGreaterThan(updateIdx);
  });
});

describe("intake submit → notification is privacy-safe", () => {
  it("body is safe text with a client-name fallback, no raw intake answers", () => {
    const body = submitBody();
    expect(body).toMatch(/submitted an intake form\./);
    expect(body).toMatch(/A client submitted an intake form\./);
    // The notification payload must not spread the responses/merged answers.
    const payload = body.slice(body.indexOf("recordPractitionerNotification("));
    expect(payload).not.toMatch(/\bresponses\b/);
    expect(payload).not.toMatch(/\bmerged\b/);
    expect(payload).not.toMatch(/\btoken\b/);
  });

  it("only the client name is looked up for the body (no health columns)", () => {
    const body = submitBody();
    // The client lookup selects the display name only.
    expect(body).toMatch(/\.from\("clients"\)\s*\n?\s*\.select\("name"\)/);
    expect(body).toMatch(/\.eq\("studio_id", existing\.studio_id\)/);
  });
});
