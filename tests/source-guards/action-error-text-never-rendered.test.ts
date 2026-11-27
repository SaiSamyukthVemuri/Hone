import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// HON-124 item 19. A form must never put a caught error's OWN text on screen. Next redacts a thrown server-action message in production
// (the person sees "An error occurred in the Server Components render..."), and in development the message can carry internal codes.
// Forms map a caught error through actionFailureMessage(), and expected failures are RETURNED as { ok: false, error } (lib/actions/action-result.ts).
//
// THE ALLOW-LIST BELOW ONLY SHRINKS. Each entry is a not-yet-converted site with the reason it is still here. A later PR deletes its entries
// as it converts the files; an entry whose file no longer leaks FAILS this test (delete it), and the list can never grow past the ceiling.
const ROOT = path.resolve(__dirname, "../..");

const NOT_YET_CONVERTED: Record<string, string> = {
  // availability: PR-2 (actions throw today; four client sections print the thrown text)
  "app/(app)/settings/availability/AvailabilityClient.tsx": "availability PR-2: save/delete actions still throw",
  // B-group: actions already RETURN {ok:false,error}; only the rare unexpected-throw catch still prints the text
  "app/(app)/settings/availability/RecurringBreaksSection.tsx": "B-group fallback catch (actions return errors); convert with availability PR-2",
  "app/(app)/settings/availability/TimedBlocksSection.tsx": "B-group fallback catch (actions return errors); convert with availability PR-2",
  "app/(app)/calendar/TimedBlockEditDrawer.tsx": "B-group fallback catch (actions return errors); convert with availability PR-2",
  "app/(app)/settings/calendar/StudioDisplayPreferencesForm.tsx": "B-group fallback catch; its action also returns 'Failed to update display preferences: <code>'",
  // payments: held until #1821 (Stripe onboarding rework) merges
  "app/(app)/settings/payments/PaymentsSettings.tsx": "payments PR: waits for #1821 onboarding rework",
  // client cards and logging forms: PR-3 (prop actions typed Promise<void>, so they can only throw)
  "components/add-pricing-form.tsx": "client cards PR-3: action is Promise<void>",
  "components/client-pinned-notes-card.tsx": "client cards PR-3: actions are Promise<void>/unknown",
  "components/client-tags-card.tsx": "client cards PR-3: actions are Promise<void>",
  "components/log-electrolysis-entry-form.tsx": "client cards PR-3: action is Promise<void>",
  "components/log-laser-entry-form.tsx": "client cards PR-3: action is Promise<void>",
  "components/session-performer-line.tsx": "client cards PR-3: action is Promise<void>",
  "app/(app)/clients/[id]/sessions/[sessionId]/DeleteSessionForm.tsx": "client cards PR-3: softDeleteSessionAction throws",
  // outside item 19: the sign-in provider's own message, a different surface
  "app/(auth)/login/page.tsx": "auth provider message; not a settings/client server action",
};
const CEILING = 14;

// err/e/error/ex/caught . message, or `instanceof Error ? x.message`, after comments are removed.
const LEAK = /\b(?:err|e|error|ex|caught)(?: as [A-Za-z]+)?\.message\b/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const files = execFileSync("git", ["ls-files", "app", "components"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter((f) => f.endsWith(".tsx"));
// Route error boundaries render fixed copy (and say so); a server component never has a caught client error to print.
const leaking = files.filter((f) => LEAK.test(stripComments(readFileSync(path.join(ROOT, f), "utf8"))));

describe("no form renders a caught error's own text", () => {
  it("every leaking file is on the explicit allow-list", () => {
    const unexpected = leaking.filter((f) => !(f in NOT_YET_CONVERTED));
    expect(unexpected, "convert with actionFailureMessage / a returned {ok:false,error}; do NOT add to the allow-list").toEqual([]);
  });
  it("the allow-list only shrinks: an entry whose file no longer leaks must be deleted, and it may never grow", () => {
    const stale = Object.keys(NOT_YET_CONVERTED).filter((f) => !leaking.includes(f));
    expect(stale, "converted? delete the entry").toEqual([]);
    expect(Object.keys(NOT_YET_CONVERTED).length).toBeLessThanOrEqual(CEILING);
  });
  it("the five forms converted in PR-1 are not on it and do not leak", () => {
    for (const f of [
      "app/(app)/settings/studio/StudioSettingsForm.tsx",
      "app/(app)/settings/studio/PolicySettingsForm.tsx",
      "app/(app)/settings/studio/PostcareSettingsForm.tsx",
      "app/(app)/settings/profile/ProfileForm.tsx",
      "app/(app)/settings/profile/ColorPicker.tsx",
    ]) {
      expect(f in NOT_YET_CONVERTED).toBe(false);
      expect(leaking).not.toContain(f);
    }
  });
});
