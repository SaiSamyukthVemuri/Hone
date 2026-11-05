import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROFILE_COMPLETE,
  PROFILE_INCOMPLETE,
  assessProfileCompleteness,
  completionDraftFromStored,
  completionPatchFromProfile,
  displayName,
  emptyJoinProfileDraft,
  invitationEligibility,
  validateJoinProfileDraft,
  validateWaitlistJoinProfile,
  type RawJoinProfileInput,
} from "@/lib/waitlist/join-profile";

// Waitlist single legal name (HON-58). A person with ONE legal name is supported without a made-up
// family name. The answer is an explicit flag, never inferred from a blank last name, and the
// two-name path is unchanged.

function input(over: Partial<RawJoinProfileInput> = {}): RawJoinProfileInput {
  return {
    firstName: "Cher",
    lastName: "",
    singleLegalName: true,
    email: "cher@example.com",
    mobile: "07700 900123",
    treatmentAreaIds: ["chin"],
    availabilityPreference: "weekdays",
    smsOperationalConsent: false,
    ...over,
  };
}

describe("validation", () => {
  it("accepts one legal name with the flag and no last name; nothing is invented", () => {
    const r = validateWaitlistJoinProfile(input());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.firstName).toBe("Cher");
      expect(r.value.lastName).toBe("");
      expect(r.value.singleLegalName).toBe(true);
    }
  });
  it("still requires a last name without the flag (blank is never read as a single name)", () => {
    const r = validateWaitlistJoinProfile(input({ singleLegalName: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.lastName).toBeTruthy();
    const absent = validateWaitlistJoinProfile(input({ singleLegalName: undefined }));
    expect(absent.ok).toBe(false);
  });
  it("refuses a last name that rides along with the one-name answer", () => {
    const r = validateWaitlistJoinProfile(input({ lastName: "Sarkisian" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.lastName).toBeTruthy();
  });
  it("only the literal true counts as the flag", () => {
    for (const v of ["true", 1, "on", {}]) {
      expect(validateWaitlistJoinProfile(input({ singleLegalName: v })).ok).toBe(false);
    }
  });
  it("still requires the first name", () => {
    const r = validateWaitlistJoinProfile(input({ firstName: "  " }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.firstName).toBeTruthy();
  });
  it("a normal two-name submission is unchanged and carries singleLegalName false", () => {
    const r = validateWaitlistJoinProfile(input({ lastName: "Jones", singleLegalName: undefined }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.singleLegalName).toBe(false);
  });
  it("draft bridge carries the flag", () => {
    const d = { ...emptyJoinProfileDraft(), firstName: "Cher", singleLegalName: true, email: "c@example.com", mobile: "07700 900123", treatmentAreaIds: ["chin" as const], availabilityPreference: "both" as const };
    expect(validateJoinProfileDraft(d).ok).toBe(true);
    expect(emptyJoinProfileDraft().singleLegalName).toBe(false);
  });
});

describe("completeness and invitation eligibility", () => {
  const base = { firstName: "Cher", email: "c@example.com", mobile: "07700 900123", treatmentAreaIds: ["chin"], availabilityPreference: "both" };
  it("a stored single-name profile is complete", () => {
    expect(assessProfileCompleteness({ ...base, lastName: null, singleLegalName: true }).status).toBe(PROFILE_COMPLETE);
    expect(invitationEligibility({ ...base, lastName: null, singleLegalName: true }).eligible).toBe(true);
  });
  it("a blank last name WITHOUT the explicit answer is still incomplete", () => {
    const a = assessProfileCompleteness({ ...base, lastName: null, singleLegalName: false });
    expect(a.status).toBe(PROFILE_INCOMPLETE);
    expect(a.status === PROFILE_INCOMPLETE && a.missing).toContain("lastName");
    expect(assessProfileCompleteness({ ...base, lastName: null }).status).toBe(PROFILE_INCOMPLETE);
  });
  it("the flag does not excuse a stored last name that is also present (flag needs an absent last name)", () => {
    // A row with both is complete through the normal two-name rule, not through the flag.
    expect(assessProfileCompleteness({ ...base, lastName: "Jones", singleLegalName: true }).status).toBe(PROFILE_COMPLETE);
  });
  it("legacy rows (no flag) behave exactly as before", () => {
    expect(assessProfileCompleteness({ ...base, lastName: "Jones" }).status).toBe(PROFILE_COMPLETE);
    expect(assessProfileCompleteness({ ...base }).status).toBe(PROFILE_INCOMPLETE);
  });
  it("display shows the single name as given, never a fabricated surname", () => {
    expect(displayName({ firstName: "Cher", lastName: null, singleLegalName: true })).toBe("Cher");
  });
  it("completion draft seeds the flag only when stored true with no last name", () => {
    expect(completionDraftFromStored({ ...base, lastName: null, singleLegalName: true }).singleLegalName).toBe(true);
    expect(completionDraftFromStored({ ...base, lastName: "Jones", singleLegalName: true }).singleLegalName).toBe(false);
    expect(completionDraftFromStored({ ...base, lastName: null }).singleLegalName).toBe(false);
  });
});

describe("completion patch", () => {
  it("carries the flag and an empty last name", () => {
    const v = validateWaitlistJoinProfile(input());
    if (!v.ok) throw new Error("fixture invalid");
    const patch = completionPatchFromProfile(v.value, { mobile: null });
    expect(patch.singleLegalName).toBe(true);
    expect(patch.lastName).toBe("");
  });
});

// ---- the adapter -----------------------------------------------------------
type Call = { fn: string; args: Record<string, unknown> };
const h: { calls: Call[] } = { calls: [] };
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    async rpc(fn: string, args: Record<string, unknown>) {
      h.calls.push({ fn, args });
      return { data: "accepted", error: null };
    },
  }),
}));
const server = await import("@/lib/waitlist/profile-completion-server");

const TOKEN = "tok_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SINGLE = {
  firstName: "Cher",
  lastName: "",
  singleLegalName: true,
  treatmentAreaIds: ["chin" as const],
  availabilityPreference: "weekdays" as const,
  mobileDisposition: "unchanged" as const,
};

describe("adapter (migration 0286 is held, so the option is dark)", () => {
  beforeEach(() => {
    h.calls = [];
  });
  it("the capability is off, so a single-name completion is refused and nothing is written", async () => {
    expect(server.WAIT_04B_CAPABILITIES.singleLegalName).toBe(false);
    const r = await server.completeWaitlistProfile({ capabilityToken: TOKEN, patch: SINGLE, smsOperationalConsent: false, consentSource: "prospect_link" });
    expect(r).toEqual({ ok: false, code: "unavailable" });
    expect(h.calls).toEqual([]);
  });
  it("with the capability on (after 0286 is applied) it calls the v2 command with p_single_name and an empty last name", async () => {
    const caps = server.WAIT_04B_CAPABILITIES as { singleLegalName?: boolean };
    caps.singleLegalName = true;
    try {
      const r = await server.completeWaitlistProfile({ capabilityToken: TOKEN, patch: SINGLE, smsOperationalConsent: false, consentSource: "prospect_link" });
      expect(r).toEqual({ ok: true });
      expect(h.calls[0].fn).toBe("complete_waitlist_profile_by_grant_v2");
      expect(h.calls[0].args.p_single_name).toBe(true);
      expect(h.calls[0].args.p_last_name).toBe("");
    } finally {
      caps.singleLegalName = false;
    }
  });
  it("a two-name completion still calls the v1 command with the exact v1 arguments (no p_single_name)", async () => {
    const r = await server.completeWaitlistProfile({
      capabilityToken: TOKEN,
      patch: { ...SINGLE, firstName: "Ada", lastName: "Lovelace", singleLegalName: false },
      smsOperationalConsent: false,
      consentSource: "prospect_link",
    });
    expect(r).toEqual({ ok: true });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].fn).toBe("complete_waitlist_profile_by_grant");
    expect("p_single_name" in h.calls[0].args).toBe(false);
    expect(h.calls[0].args.p_last_name).toBe("Lovelace");
  });
  it("an older patch with no flag is treated as two-name (v1)", async () => {
    const { singleLegalName: _drop, ...older } = { ...SINGLE, firstName: "Ada", lastName: "Lovelace" };
    void _drop;
    const r = await server.completeWaitlistProfile({ capabilityToken: TOKEN, patch: older, smsOperationalConsent: false, consentSource: "prospect_link" });
    expect(r).toEqual({ ok: true });
    expect(h.calls[0].fn).toBe("complete_waitlist_profile_by_grant");
  });
});

describe("adapter routing once enabled", () => {
  it("every completion goes through v2, two-name with p_single_name false", async () => {
    h.calls = [];
    const caps = server.WAIT_04B_CAPABILITIES as { singleLegalName?: boolean };
    caps.singleLegalName = true;
    try {
      const r = await server.completeWaitlistProfile({
        capabilityToken: TOKEN,
        patch: { ...SINGLE, firstName: "Ada", lastName: "Lovelace", singleLegalName: false },
        smsOperationalConsent: false,
        consentSource: "prospect_link",
      });
      expect(r).toEqual({ ok: true });
      expect(h.calls[0].fn).toBe("complete_waitlist_profile_by_grant_v2");
      expect(h.calls[0].args.p_single_name).toBe(false);
      expect(h.calls[0].args.p_last_name).toBe("Lovelace");
    } finally {
      caps.singleLegalName = false;
    }
  });
});

// Privacy C1/C2: the option cannot be switched on early, and no join form can offer it.
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === ".next" || n.startsWith(".")) continue;
    const f = join(dir, n);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.(tsx?|sql)$/.test(n)) out.push(f);
  }
  return out;
}
describe("the option cannot be enabled early", () => {
  it("capability true requires a migration in the repo that defines the v2 command", () => {
    const migs = readdirSync(join(process.cwd(), "supabase/migrations")).filter((n) => n.endsWith(".sql"));
    const defined = migs.some((n) =>
      /create (or replace )?function public\.complete_waitlist_profile_by_grant_v2/i.test(
        readFileSync(join(process.cwd(), "supabase/migrations", n), "utf8"),
      ),
    );
    if (server.WAIT_04B_CAPABILITIES.singleLegalName === true) expect(defined).toBe(true);
  });
  it("no caller passes singleNameOption true while the capability is off", () => {
    if (server.WAIT_04B_CAPABILITIES.singleLegalName === true) return;
    const offenders = [...walk(join(process.cwd(), "app")), ...walk(join(process.cwd(), "components"))].filter((f) =>
      /singleNameOption(=\{true\}|\s*=\s*\{?\s*true|\s*$|\s+[a-zA-Z/>])/m.test(readFileSync(f, "utf8").replace(/singleNameOption\??: boolean/g, "")) && !f.endsWith("profile-fields.tsx"),
    );
    expect(offenders).toEqual([]);
  });
});
