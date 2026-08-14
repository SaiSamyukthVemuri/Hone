import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const BRIEFING = "app/(app)/calendar/[id]/page.tsx";
const PROFILE = "app/(app)/clients/[id]/page.tsx";
const CARD = "components/treatment-plans-card.tsx";

describe("create-plan-from-appointment: briefing CTA", () => {
  const b = read(BRIEFING);
  it("shows a primary 'Create treatment plan' CTA + a secondary 'View treatment plans'", () => {
    expect(b).toMatch(/Create treatment plan/);
    expect(b).toMatch(/View treatment plans/);
  });
  it("CTA opens the treatment tab + create form with returnTo to THIS appointment, using the appointment's own client id", () => {
    expect(b).toMatch(/\/clients\/\$\{client\.id\}\?tab=treatment&create_plan=1&returnTo=/);
    expect(b).toMatch(/encodeURIComponent\(\s*`\/calendar\/\$\{appointmentId\}`/);
    expect(b).toMatch(/appointmentId=\{id\}/); // the route param, never a browser-supplied id
  });
});

describe("create-plan-from-appointment: profile page wiring", () => {
  const p = read(PROFILE);
  it("auto-open gated on create_plan=1 AND the treatment tab; returnTo sanitized server-side", () => {
    expect(p).toMatch(/const autoOpenCreatePlan = sp\.create_plan === "1" && activeTab === "treatment"/);
    expect(p).toMatch(/sanitizeAppointmentReturnTo\(sp\.returnTo\)/);
    expect(p).toMatch(/autoOpenCreate=\{autoOpenCreatePlan\}/);
    expect(p).toMatch(/returnTo=\{planReturnTo\}/);
  });
});

describe("create-plan-from-appointment: card opens but never auto-creates", () => {
  const c = read(CARD);
  it("opens the EXISTING form on autoOpenCreate + focuses the first field + shows the Back link", () => {
    expect(c).toMatch(/useState\(autoOpenCreate\)/);
    expect(c).toMatch(/autoFocus=\{autoOpenCreate\}/);
    expect(c).toMatch(/Back to appointment/);
  });
  it("reuses the existing createAction; creating happens ONLY on submit, never on open/mount", () => {
    expect(c).toMatch(/await createAction\(fd\)/); // the one existing create path
    // the open-state init line never calls createAction
    const i = c.indexOf("useState(autoOpenCreate)");
    expect(c.slice(i, i + 60)).not.toMatch(/createAction/);
    expect((c.match(/createAction\(/g) ?? []).length).toBe(1); // no NEW create call added
  });

  it("closing the form (Cancel or Save) strips the deep-link params via Next replace, refresh won't reopen", () => {
    expect(c).toMatch(/import \{ useRouter \} from "next\/navigation"/);
    expect(c).toMatch(/router\.replace\(`\/clients\/\$\{clientId\}\?tab=treatment`, \{ scroll: false \}\)/);
    // invoked from BOTH close paths: Cancel + Save success.
    expect((c.match(/clearCreateUrlParams\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
