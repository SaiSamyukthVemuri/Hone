import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Finding 3: the completion path must NEVER surface a raw Supabase/Postgres
// error.message (which can carry studio names, ids, or DB internals). It returns
// fixed owner-facing codes and logs only a bounded marker.

const STATE = readFileSync(
  path.resolve(__dirname, "../../../lib/onboarding/state.ts"),
  "utf8",
);
const ACTIONS = readFileSync(
  path.resolve(__dirname, "../../../app/(app)/dashboard/onboarding-actions.ts"),
  "utf8",
);

function block(src: string, re: RegExp): string {
  return src.match(re)?.[0] ?? "";
}

describe("completion/celebration never leak raw DB error text", () => {
  const complete = block(
    STATE,
    /export async function completeOnboarding\([\s\S]*?\n\}/,
  );
  const celebrate = block(
    STATE,
    /export async function markCelebrated\([\s\S]*?\n\}/,
  );

  it("state.completeOnboarding does not return or read error.message", () => {
    expect(complete).toBeTruthy();
    expect(complete).not.toMatch(/error\.message/);
    expect(complete).not.toMatch(/error:\s*error/);
    // Bounded marker only.
    expect(complete).toMatch(/logOnboardingDbError\("complete"/);
  });

  it("state.markCelebrated does not return or read error.message", () => {
    expect(celebrate).toBeTruthy();
    expect(celebrate).not.toMatch(/error\.message/);
    expect(celebrate).toMatch(/logOnboardingDbError\("celebrate"/);
  });

  it("the bounded marker is onboarding_action_db_error:<op>:<safe_code>, no leaky interpolation", () => {
    const marker = block(STATE, /function logOnboardingDbError[\s\S]*?\n\}/);
    expect(marker).toMatch(/onboarding_action_db_error:\$\{op\}:\$\{code\}/);
    // The only interpolations are the safe op + code, nothing DB/PII-shaped.
    expect(marker).not.toMatch(/\$\{\s*(error|studio|user|data)/i);
    expect(marker).not.toMatch(/\.message/);
  });

  it("the actions return FIXED codes, never res.error / error.message", () => {
    const completeAction = block(
      ACTIONS,
      /export async function completeOnboardingAction\([\s\S]*?\n\}/,
    );
    const celebrateAction = block(
      ACTIONS,
      /export async function markCelebrationShownAction\([\s\S]*?\n\}/,
    );
    expect(completeAction).toMatch(/error: "complete_failed"/);
    expect(completeAction).not.toMatch(/error\.message|res\.error/);
    expect(celebrateAction).toMatch(/error: "celebrate_failed"/);
    expect(celebrateAction).not.toMatch(/error\.message|res\.error/);
  });
});
