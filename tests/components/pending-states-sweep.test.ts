import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// HON-124 item 4. Every plain-<button> server-action mutation found in settings, clients and the waitlist reply/handling surfaces now submits
// through PendingButton (useFormStatus -> aria-busy + disabled + geometry-stable spinner, honouring reduced motion in Button). The disable IS the
// double-submit guard. Each case pins the FORM'S ACTION to a PendingButton inside the same form, so a raw <button type="submit"> cannot return.
const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

// For each `<form action={name}` find its closing </form> and return the slice between.
function formBody(src: string, action: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<form[^>]*\\baction=\\{${action}\\}`, "g");
  for (const m of src.matchAll(re)) out.push(src.slice(m.index!, src.indexOf("</form>", m.index!)));
  return out;
}

const CASES: Array<[file: string, actions: string[]]> = [
  ["app/(app)/clients/[id]/page.tsx", ["deleteClientPricingAction"]],
  ["app/(app)/settings/availability/AvailabilityClient.tsx", ["deleteOverrideAction", "deleteBlockoutAction"]],
  ["app/(app)/settings/waitlist/page.tsx", ["removeWaitlistEntryAction"]],
  ["app/(app)/settings/waitlist/replies/page.tsx", ["acknowledgeReplyAction"]],
  ["components/waitlist/decline-follow-up-section.tsx", ["eraseAnswersAction", "markHandledAction", "keepWithdrawalAction", "linkAppointmentAction"]],
];

describe("mutation forms submit through PendingButton", () => {
  for (const [file, actions] of CASES) {
    for (const action of actions) {
      it(`${file}: ${action}`, () => {
        const bodies = formBody(read(file), action);
        expect(bodies.length).toBeGreaterThan(0);
        for (const b of bodies) {
          expect(b).toContain("<PendingButton");
          expect(b).not.toMatch(/<button\b[^>]*type="submit"/);
        }
      });
    }
  }
  it("the waitlist row actions (a form per action) use PendingButton too", () => {
    const src = read("app/(app)/settings/waitlist/page.tsx");
    const i = src.indexOf("<form key={action} action={formAction}>");
    expect(i).toBeGreaterThan(-1);
    const body = src.slice(i, src.indexOf("</form>", i));
    expect(body).toContain("<PendingButton");
    expect(body).toContain("data-testid={`waitlist-action-${action}`}");
    expect(body).not.toMatch(/<button\b/);
  });
});
