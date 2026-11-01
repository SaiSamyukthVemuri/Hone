import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
// @ts-expect-error - .mjs utilities ship without type declarations
import { selectBrowserGroups, specsForGroups, BROWSER_GROUPS, EXTENDED } from "../../scripts/browser-groups.mjs";
// @ts-expect-error - .mjs utilities ship without type declarations
import { buildPlan } from "../../scripts/ci-plan.mjs";

type Sel = { groups: string[]; extended: boolean; reason: string };
const sel = (...files: string[]) => selectBrowserGroups(files) as Sel;
const plan = (...files: string[]) => buildPlan(files) as ReturnType<typeof buildPlan>;
const laneRuns = (p: ReturnType<typeof plan>, name: string) =>
  (p.lanes as Array<{ lane: string; run: boolean }>).find((l) => l.lane.startsWith(name))?.run;

describe("browser group manifest integrity", () => {
  it("maps every spec on disk to exactly one group", () => {
    const disk = readdirSync("e2e").filter((f) => f.endsWith(".spec.ts"));
    const mapped = Object.values(BROWSER_GROUPS as Record<string, { specs: string[] }>).flatMap(
      (g) => g.specs,
    );
    const unmapped = disk.filter((f) => !mapped.includes(f));
    expect(unmapped, "every spec must belong to a group or it will never run in a targeted lane").toEqual([]);
    // No duplicates across groups — a spec in two groups would run twice.
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  it("references no spec that does not exist", () => {
    const disk = new Set(readdirSync("e2e").filter((f) => f.endsWith(".spec.ts")));
    const mapped = Object.values(BROWSER_GROUPS as Record<string, { specs: string[] }>).flatMap((g) => g.specs);
    expect(mapped.filter((f) => !disk.has(f))).toEqual([]);
  });

  it("every group documents its purpose", () => {
    for (const [name, def] of Object.entries(BROWSER_GROUPS as Record<string, { description: string }>)) {
      expect(def.description.length, `${name} needs a description`).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// The ten acceptance cases, table-driven.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Timeout-margin fix (fix/targeted-browser-timeout-margin): this PR changes ONLY
// the targeted shard's hard timeout. These pins prove it changed no selection.
// ---------------------------------------------------------------------------

describe("browser selection is UNCHANGED by the timeout-margin fix", () => {
  it("the group set is exactly the ten existing groups", () => {
    expect(Object.keys(BROWSER_GROUPS as Record<string, unknown>).sort()).toEqual([
      "booking",
      "calendar",
      "google",
      "intake",
      "marketing",
      "owner_admin",
      "portal",
      "responsive",
      "sessions",
      "smoke",
    ]);
  });

  it("the manifest still maps every spec, and the targeted lane still selects 30", () => {
    const mapped = Object.values(BROWSER_GROUPS as Record<string, { specs: string[] }>).flatMap(
      (g) => g.specs,
    );
    // 58 since practitioner-assisted-intake.spec.ts joined the intake group
    // (57 after PR #518 added intake-electrolysis-acknowledgement.spec.ts).
    // 64 with B7's public-cancel-policy-change.spec.ts mapped into `portal`
    // (63 before it). 65 with the Chloe D1 dashboard-treatment-memory-inline
    // spec mapped into `sessions` (#565), and 66 with repeat-client-fast-
    // charting.spec.ts mapped into `sessions` too (#564, this branch).
    //
    // RECONCILED ACROSS BOTH BRANCHES. #565 and #564 were developed in parallel
    // and BOTH added one e2e spec, so both bumped this literal from 64 to 65 —
    // the same text, on the same line, for different reasons. Git merges an
    // identical edit on both sides WITHOUT a conflict, so a hard-coded count
    // here would have merged clean and silently claimed 65 when the disk had
    // 66. That is exactly the failure this assertion exists to catch, and it
    // would have been the assertion telling the lie.
    //
    // So the count is DERIVED from the disk. It cannot drift, cannot be
    // half-merged, and it still catches the one direction that matters: a spec
    // on disk that no group maps, which would silently never run.
    const onDisk = readdirSync("e2e").filter((f) => f.endsWith(".spec.ts"));
    expect(mapped).toHaveLength(onDisk.length);
    expect([...mapped].sort()).toEqual([...onDisk].sort());
    // The exact selection that was cancelled twice at the old 10-minute
    // ceiling (28), plus ONE spec from #565 and ONE from #564, both of which
    // joined `sessions`, ONE more from the 0181 multi-studio session-start
    // regression, and now ONE from 0183 client budget context — the Budget
    // card is a peer section of Consultation & Skin/Hair, so it also joined
    // `sessions`. Hence 32. Now 33: the Chloe Today-row pass
    // (dashboard-current-client-card-status.spec.ts) joined `sessions`
    // alongside the other Dashboard Today specs. Now 34: Chloe's day
    // navigation (dashboard-day-navigation.spec.ts) joined `sessions` for the
    // same reason — it drives the same Today roster. Now 35: the selected-day
    // preparation spec (dashboard-selected-day-prep.spec.ts) joined for the
    // same reason.
    //
    // This literal is a DELIBERATE COST PIN for the targeted lane, not a
    // migration-style "trip on the next one" pin: the targeted browser lane
    // has been cancelled at its ceiling before, so a spec joining this
    // selection must be a visible decision rather than a silent +1.
    // Now 36: dashboard-all-pinned-notes.spec.ts joined for the same reason —
    // it drives the same Today roster (all pinned notes + the Chart session
    // action). Recorded as a DECISION, per the note above: the targeted lane
    // has a ~6 min target against a 15 min ceiling, and this adds one spec with
    // two short cases, so the margin is not the concern here — the visibility
    // is.
    // Now 37: ui06-dashboard-chrome.spec.ts joined `sessions`, and unlike the
    // UI-04 spec — which was deliberately kept OUT of this selection because
    // app/(app)/clients/** matches no PATH_TO_GROUP pattern and so gained no
    // targeting from membership — this one earns its place: PATH_TO_GROUP maps
    // /treatment[-_]?memory/i to `sessions`, and the three cards it proves ARE
    // the treatment-memory surface. A diff to them selects this group, so the
    // spec runs in the lane that can actually break it.
    //
    // RECORDED AS A DECISION, per the note above. Cost: 10 cases (three
    // viewports x three assertions, plus one motion check) at roughly 4-5s
    // each, so about 45s against a ~6 min target and a 15 min ceiling. The
    // margin is not the concern; the visibility is.
    //
    // Now 38: SESSION-START-01's modality-acknowledgement proof joined
    // `sessions` because /clients/[id]/sessions/new is a sessions route.
    // RECORDED AS A DECISION, per the note above. Cost: EIGHT executed cases
    // (seven test() declarations, one of which loops over desktop and 390px),
    // at roughly 4-8s each — the three that hold the server action are the slow
    // ones by design. That is well under a minute against a ~6 min target and a
    // 15 min ceiling, so the margin is not the concern; the visibility is.
    //
    // The count was prose-only and said "three" through several revisions of
    // this slice while the file already ran seven. A cost pin whose NUMBER is
    // asserted and whose DESCRIPTION is not will drift exactly this way, so the
    // description is now stated in terms a reader can check against the file.
    //
    // Now 39: SESSION-START-01 slice 2A's measurement rig joined `sessions`
    // because it drives that journey. RECORDED AS A DECISION per the note above,
    // with the cost explicitly ZERO: the spec skips itself unless
    // HONE_PERF_TIMING=1, so the lane gains a selection entry and no runtime.
    //
    // Now 40: MPX-03's machine-first-charting.spec.ts joined `sessions` because
    // the machine panel lives IN the settings-block form, the same surface
    // conditional-numbing-notes and repeat-client-fast-charting drive - and
    // those two are exactly the specs an earlier version of that panel broke,
    // so it must run in the lane that can break it.
    //
    // RECORDED AS A DECISION, with the cost MEASURED rather than estimated.
    // ONE test() at 390px only, with ten steps. Its runtime depends on the
    // SERVER's environment, which is unusual enough to state:
    //   * without HONE_SYNTHETIC_MACHINE_PROFILE=1 in webServer.env it runs
    //     steps 1-2 and the gate-closed branch - MEASURED 7.3s - and still
    //     asserts the claim that matters, that no real model is offered;
    //   * with the flag set it runs all ten - MEASURED 34.9s.
    // Both on an isolated local stack, re-measured 2026-10-16 on the tree
    // synced with production (the 2026-10-15 figures were 7.3s and 37.1s on
    // the pre-sync tree; a measurement names the tree it measured). THE ESTIMATES THIS
    // REPLACES WERE 15-20s AND 45-70s, so the one that matters for CI was
    // overstated by more than double - and CI only ever runs the CLOSED half,
    // because the flag is not in its webServer.env.
    //
    // Now 41: MPX-03's machine-create-mode-journey.spec.ts joined `sessions`
    // for the same reason as its sibling - it drives the settings-block form.
    // It is a SEPARATE file rather than more steps on the existing one because
    // it proves something that spec structurally cannot: what the machine
    // panel may and may not do BEFORE the settings block exists. The sibling
    // enters on a block that already exists, so the create-mode half of the
    // journey has never been mounted at all.
    //
    // RECORDED AS A DECISION, with the cost MEASURED. ONE test() at 390px
    // only, with eight steps, and its runtime depends on the SERVER's
    // environment exactly as the sibling's does:
    //   * gate closed, step 1 and the gate-closed branch - MEASURED 7.0s;
    //   * gate open, all eight steps - MEASURED 20.6s.
    // Re-measured 2026-10-16 on the synced tree; 9.5s and 24.6s pre-sync.
    // The estimate this replaces was 60-90s for the open half: nearly three
    // times the truth. Estimating browser cost upward feels prudent and is
    // not - it is how a lane acquires a budget nobody trusts.
    //
    // Now 42: MPX-03's machine-switch-discards-draft.spec.ts joined `sessions`
    // for the third time for the same reason - it drives the settings-block
    // form's machine panel - and filing it anywhere else would hide it from
    // the only lane its subject can regress in.
    //
    // A SEPARATE FILE, again for a structural reason rather than convenience:
    // it changes the machine and the mode UNDERNEATH a draft and asserts what
    // must NOT be in the record afterwards, so its row counts are deltas of
    // things that did not happen. The journey's counts are the arithmetic of
    // one walk down the happy path; merging the two would mean re-deriving
    // every count in the journey for cases unrelated to it, which is exactly
    // how that spec's counts went stale three times.
    //
    // COST, MEASURED on an isolated local stack on 2026-10-15. ONE test() at
    // 390px with seven steps:
    //   * gate closed - 6.0s;
    //   * gate open - 21.2s, with four navigations, one block save, three
    //     reading saves, one refused save and about fifteen queries, now
    //     including the clear-to-none limb added for Codex's P1.
    // Re-measured 2026-10-16 on the synced tree; 6.8s and 18.7s pre-sync.
    // The estimate said "should land near the journey's 22.3s", and it came in
    // under it.
    //
    // Now 43: MPX-03's machine-initial-save-retry.spec.ts, the fourth spec in
    // `sessions` from this lane and the one with the least substitutable job.
    // It drops the RESPONSE to the first Save - performing the request so the
    // server commits, then failing the page's fetch - reads the database to
    // prove the area is already there, and presses Save again. What that shows
    // is that the APPLICATION reuses its retry key, which no database test can
    // see: the DB proves the command absorbs a repeat carrying the same key,
    // and a form minting a fresh key per attempt would leave every one of
    // those tests passing with the hole wide open.
    //
    // COST, MEASURED on an isolated local stack on 2026-10-15. ONE test() at
    // 390px, four steps, two saves and about eight queries:
    //   * gate closed - 6.2s;
    //   * gate open - 9.7s, the lightest of the four, as predicted.
    // Re-measured 2026-10-16 on the synced tree; 8.2s and 13.0s pre-sync.
    //
    // THE FOUR MACHINE SPECS TOGETHER, which is the number this pin exists to
    // keep visible: 25.2s with the gate CLOSED and 86.4s with it open. CI runs
    // the closed half, so the lane pays about half a minute for all four -
    // against a ~6 min target and a 15 min ceiling. The estimates these
    // measurements replace added up to roughly two and a half minutes for two
    // of them alone.
    // Now 44 (production df33a762 had 40 with HON-48; the four machine specs above are on top): HON-48's team day view joined `calendar`, the group its
    // /calendar paths already select. RECORDED AS A DECISION per the note
    // above. Cost: SIX executed cases (six test() declarations, no loops): one
    // SQL-only row check, four desktop page loads (one also steps to the next
    // day) and one 390px touch page load, each a few seconds against the ~6 min
    // target and 15 min ceiling.
    // Now 46: the HON-48 day-layout matrix (calendar-day-layout.spec.ts and calendar-day-layout-single.spec.ts) joined `calendar`, the group
    // the /calendar paths already select. RECORDED AS A DECISION per the note above. Cost: ZERO executed cases in this lane: both files
    // self-skip unless CAL_LAYOUT_E2E=1 (the matrix is ~11 min of serial browser time, run locally at a PR's exact head), so a targeted
    // lane lists them and executes nothing.
    // Now 47: Insurance PEER-1308 D-4's dashboard-closed-row.spec.ts joined `sessions` with the other Today-roster specs.
    // RECORDED AS A DECISION per the note above. Cost: ONE case, a few seconds (one seeded client, one page load, one click).
        expect(specsForGroups(["calendar", "sessions", "smoke"])).toHaveLength(47);
  });

  it("ONE unattributable app file forces extended, even when another file attributes a group", () => {
    // The real gap, found while building Dashboard V2 Part 1. The fail-safe
    // used to run only when the WHOLE diff selected zero groups, so a single
    // co-changed attributable file cancelled the safety net for every file that
    // was not attributable.
    //
    // Measured at the time: `app/(app)/dashboard/page.tsx` alone correctly
    // selected extended, but that same file plus one calendar test selected
    // `calendar` + `smoke` — the restructured dashboard entirely uncovered,
    // because something ELSE in the commit happened to be attributable.
    //
    // The first attempt at a fix was to add a `/dashboard/i` pattern. That was
    // WRONG and is deliberately not what shipped: attributing the path made a
    // dashboard-only change NARROWER than before (24 specs instead of all of
    // them). Unattributable code must widen, never narrow.
    const alone = selectBrowserGroups(["app/(app)/dashboard/page.tsx"]);
    expect(alone.extended, "unattributable app code alone").toBe(true);

    const withFriend = selectBrowserGroups([
      "app/(app)/dashboard/page.tsx",
      "tests/app/calendar/week-starts-sunday.test.ts",
    ]);
    expect(
      withFriend.extended,
      "an attributable co-changed file must NOT cancel the fail-safe",
    ).toBe(true);
    expect(withFriend.reason).toMatch(/failing safe to extended/);
  });

  it("attributable app code still narrows, so the fail-safe did not swallow targeting", () => {
    // The two-way self-test. Without this, 'always extended' would also pass
    // the assertion above and the whole targeting system would be dead.
    const s = selectBrowserGroups(["app/(app)/clients/[id]/sessions/[sessionId]/actions.ts"]);
    expect(s.extended).toBe(false);
    expect([...s.groups].sort()).toEqual(["sessions", "smoke"]);
  });

  it("docs-only still needs no browser at all", () => {
    const s = selectBrowserGroups(["docs/13_BACKLOG_AND_DECISIONS.md"]);
    expect(s.extended).toBe(false);
    expect(s.groups).toEqual([]);
  });

  it("targeted coverage is THREE shards and extended still FOUR", () => {
    // WAS "targeted is still ONE shard". Both lanes are sharded now: the
    // targeted lane was running 36 specs in a single job at ~95% of its 15 min
    // ceiling and being cancelled on the slower half of the runner spread.
    //
    // SELECTION is what this describe block asserts is unchanged, and it still
    // is — the groups and specs above are untouched. Only the number of jobs
    // they are spread over moved.
    const targeted = plan("app/(app)/clients/[id]/sessions/[sessionId]/actions.ts").browser;
    const extended = plan("e2e/helpers/seed.ts").browser;

    expect(targeted.sharded).toBe(true);
    expect(targeted.shards).toBe(3);
    expect(extended.sharded).toBe(true);
    expect(extended.shards).toBe(4);
  });

  it("a full-matrix diff with NO browser groups is planned as the EXTENDED lane", () => {
    // `vitest.config.ts` yields no groups, so `browser_specs` is empty and the
    // shard command runs the WHOLE suite. The workflow treats that as extended
    // coverage — 4 shards, 18 min — and this planner has to agree, or it tells
    // a contributor the targeted lane runs when CI runs the other one.
    const p = plan("vitest.config.ts");
    expect(p.full_matrix_required).toBe(true);
    expect(p.browser.groups).toEqual([]);
    expect(p.browser.shards).toBe(4);
  });
});

describe("acceptance case 1 — docs-only", () => {
  const p = plan("docs/production/migration-ledger.md", "README.md");
  it("runs no DB, browser, mobile, payment or Google lane", () => {
    expect(laneRuns(p, "db integration")).toBe(false);
    expect(laneRuns(p, "browser e2e")).toBe(false);
    expect(laneRuns(p, "payment browser")).toBe(false);
    expect(laneRuns(p, "google browser")).toBe(false);
    expect(laneRuns(p, "mobile completion")).toBe(false);
    expect(laneRuns(p, "typecheck")).toBe(false);
  });
  it("selects no browser group", () => {
    expect(sel("docs/x.md").groups).toEqual([]);
  });
});

describe("acceptance case 2 — migration-only", () => {
  const p = plan("supabase/migrations/0166_x.sql", "tests/migrations/0166-x.test.ts");
  it("runs validation + DB/security only", () => {
    expect(laneRuns(p, "typecheck")).toBe(true);
    expect(laneRuns(p, "db integration")).toBe(true);
    expect(laneRuns(p, "browser e2e")).toBe(false);
    expect(laneRuns(p, "payment browser")).toBe(false);
    expect(laneRuns(p, "google browser")).toBe(false);
    expect(laneRuns(p, "mobile completion")).toBe(false);
  });
});

describe("acceptance case 3 — session UI only", () => {
  const p = plan("app/(app)/clients/[id]/sessions/[sessionId]/actions.ts");
  it("selects the sessions group (plus smoke) and no unrelated lane", () => {
    const s = sel("app/(app)/clients/[id]/sessions/[sessionId]/actions.ts");
    expect(s.groups).toContain("sessions");
    expect(s.groups).toContain("smoke");
    expect(s.extended).toBe(false);
    expect(laneRuns(p, "payment browser")).toBe(false);
    expect(laneRuns(p, "google browser")).toBe(false);
    expect(laneRuns(p, "mobile completion")).toBe(false);
  });
  it("runs materially fewer specs than the whole suite", () => {
    const specs = specsForGroups(sel("app/(app)/clients/[id]/sessions/x.ts").groups) as string[];
    const total = readdirSync("e2e").filter((f) => f.endsWith(".spec.ts")).length;
    expect(specs.length).toBeLessThan(total);
    expect(specs.length).toBeGreaterThan(0);
  });
});

describe("acceptance case 4 — intake UI only", () => {
  it("selects the intake group", () => {
    const s = sel("app/(app)/clients/[id]/intake/actions.ts");
    expect(s.groups).toContain("intake");
    expect(s.extended).toBe(false);
    expect(specsForGroups(s.groups)).toContain("intake-review-integrity.spec.ts");
  });
});

describe("acceptance case 5 — payment only", () => {
  const p = plan("app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts");
  it("runs the payment lane", () => {
    expect(laneRuns(p, "payment browser")).toBe(true);
  });
  it("does not run Google or mobile", () => {
    expect(laneRuns(p, "google browser")).toBe(false);
    expect(laneRuns(p, "mobile completion")).toBe(false);
  });
});

describe("acceptance case 6 — Google only", () => {
  const p = plan("lib/google-calendar/sync/reconcile.ts");
  it("runs the Google lane and not payment/mobile", () => {
    expect(laneRuns(p, "google browser")).toBe(true);
    expect(laneRuns(p, "payment browser")).toBe(false);
    expect(laneRuns(p, "mobile completion")).toBe(false);
  });
});

describe("acceptance case 7 — shared browser fixture", () => {
  it("forces EXTENDED coverage (sharded), never a narrow group", () => {
    for (const f of ["e2e/helpers/seed.ts", "playwright.config.ts", "lib/supabase/server.ts", "middleware.ts"]) {
      const s = sel(f);
      expect(s.extended, `${f} must force extended coverage`).toBe(true);
      expect(s.groups).toEqual([EXTENDED]);
      expect(s.reason).toMatch(/shared/i);
    }
  });
  it("extended coverage means every spec, and is sharded into four", () => {
    const p = plan("e2e/helpers/seed.ts");
    expect(p.browser.extended).toBe(true);
    expect(p.browser.sharded).toBe(true);
    expect(specsForGroups([EXTENDED])).toBeNull(); // null = run everything
  });

  it("docs-only and migration-only still select NO browser job", () => {
    expect(sel("docs/production/migration-ledger.md").groups).toEqual([]);
    expect(sel("supabase/migrations/0166_x.sql").groups).toEqual([]);
    expect(plan("supabase/migrations/0166_x.sql").browser.groups).toEqual([]);
  });

  it("migration-only still skips payment, Google and mobile", () => {
    const p = plan("supabase/migrations/0166_x.sql");
    expect(laneRuns(p, "payment browser")).toBe(false);
    expect(laneRuns(p, "google browser")).toBe(false);
    expect(laneRuns(p, "mobile completion")).toBe(false);
  });
});

describe("acceptance case 8 — workflow / CI change", () => {
  it("requires the full matrix", () => {
    const p = plan(".github/workflows/ci.yml");
    expect(p.full_matrix_required).toBe(true);
    expect(laneRuns(p, "payment browser")).toBe(true);
    expect(laneRuns(p, "google browser")).toBe(true);
    expect(laneRuns(p, "mobile completion")).toBe(true);
  });
});

describe("acceptance case 9 — unknown shared path fails safe", () => {
  it("unattributable application code falls back to extended coverage", () => {
    const s = sel("app/some-brand-new-surface/page.tsx");
    expect(s.extended).toBe(true);
    expect(s.reason).toMatch(/failing safe/i);
  });
  it("an empty diff falls back to extended coverage", () => {
    const s = sel();
    expect(s.extended).toBe(true);
    expect(s.reason).toMatch(/failing safe/i);
  });
});

describe("acceptance case 10 — superseded PR runs are cancelled", () => {
  it("the PR workflow declares a PR-scoped cancelling concurrency group", async () => {
    const { readFileSync } = await import("node:fs");
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toMatch(/group: hone-pr-ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/);
    expect(ci).toMatch(/cancel-in-progress: true/);
  });
  it("nightly concurrency stays separate from PR concurrency", async () => {
    const { readFileSync } = await import("node:fs");
    const nightly = readFileSync(".github/workflows/nightly.yml", "utf8");
    expect(nightly).toMatch(/group: nightly-/);
    expect(nightly).not.toMatch(/hone-pr-ci-/);
  });
});

describe("ci:plan output contract", () => {
  it("explains every lane decision", () => {
    const p = plan("app/(app)/clients/[id]/sessions/x.ts");
    for (const l of p.lanes as Array<{ lane: string; why: string }>) {
      expect(l.why.length, `${l.lane} must state a reason`).toBeGreaterThan(5);
    }
  });
  it("reports the selected groups and whether the full matrix is required", () => {
    const p = plan("package.json");
    expect(p.full_matrix_required).toBe(true);
    expect(p.browser.groups.length).toBeGreaterThan(0);
  });
});
