import { afterEach, describe, expect, it, vi } from "vitest";

// Decision 6: Availability is in a practitioner's settings rail only when the default-off own-hours
// flag is on (it is switched on after 0278 is applied). The owner always sees it.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/booking/new-client-admission", () => ({
  getNewClientAdmissionMode: async () => ({ ok: true, mode: "open", source: "persisted" }),
}));
vi.mock("@/lib/booking/new-client-waitlist-durability-bridge", () => ({ newClientWaitlistCommitIsDurable: () => false }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/waitlist/operator-queue-presence", () => ({ hasActiveWaitlistEntries: async () => false }));

import { resolveSettingsNav } from "@/lib/settings/nav";
import { SETTINGS_NAV } from "@/lib/settings/nav-registry";
import type { Studio } from "@/lib/types/database";

const studio = { id: "s", slug: "x" } as unknown as Studio;
const hrefs = async (role: "owner" | "practitioner") =>
  (await resolveSettingsNav(SETTINGS_NAV, { role, studio })).map((i) => i.href);

afterEach(() => vi.unstubAllEnvs());

describe("availability in the settings rail", () => {
  it("flag off (default): hidden for a practitioner, shown to the owner", async () => {
    expect(await hrefs("practitioner")).not.toContain("/settings/availability");
    expect(await hrefs("owner")).toContain("/settings/availability");
  });
  it("flag on: shown to a practitioner too, and other owner-only entries stay hidden", async () => {
    vi.stubEnv("HONE_PRACTITIONER_OWN_HOURS_ENABLED", "true");
    const p = await hrefs("practitioner");
    expect(p).toContain("/settings/availability");
    for (const h of ["/settings/studio", "/settings/team", "/settings/services", "/settings/payments", "/settings/data"]) {
      expect(p).not.toContain(h);
    }
  });
});
