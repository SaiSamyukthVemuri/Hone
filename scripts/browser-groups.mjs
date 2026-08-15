#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Browser test groups + deterministic path→group selection.
//
// MEASURED PROBLEM (GitHub Actions, runs 30764322410 / 30765446327 / 30766404661)
//   browser e2e (local stack) ......... 15.9 / 16.4 / 16.8 min
//     └─ "Browser E2E (core memory loop)" step alone .... 14.2 min
//        setup was only ~2.6 min total (Supabase 1.5, Playwright 0.4,
//        migration chain 0.3, npm ci 0.2)
//
// So caching setup is marginal. The cost is 53 specs running strictly
// serially (`fullyParallel: false, workers: 1` in playwright.config.ts).
// The fix is to run only the specs a diff can affect on a PR, and to shard
// the extended suite across SEPARATE JOBS for full/nightly runs: separate
// runners mean separate Supabase stacks, which preserves the isolation the
// single-worker config was protecting.
//
// This module is pure so the mapping is proved by table-driven tests rather
// than by pushing commits.
// ---------------------------------------------------------------------------

/**
 * Every browser group. `specs` are matched against the e2e/ filename.
 * A spec belonging to no group falls into `extended`, never dropped.
 */
export const BROWSER_GROUPS = {
  smoke: {
    description: "fastest proof the app boots, auth works and the memory loop records",
    specs: ["core-memory-loop.spec.ts", "safe-willow-contract.spec.ts"],
  },
  sessions: {
    description: "sessions / treatment-memory charting",
    specs: [
      "charting-usability-polish.spec.ts",
      "clinical-notes.spec.ts",
      "conditional-numbing-notes.spec.ts",
      "copy-settings-machine-readings.spec.ts",
      "custom-area-commit.spec.ts",
      "galvanic-intensity-retirement.spec.ts",
      "multi-area-charting.spec.ts",
      "multi-area-charting-release.spec.ts",
      "observation-chips-loading.spec.ts",
      "observation-chips-save-cycle.spec.ts",
      "picoblend-precision.spec.ts",
      "probe-inventory-linkage-mobile.spec.ts",
      "probe-lot-history-autofill-mobile.spec.ts",
      "probe-lot-scope-and-copy-mobile.spec.ts",
      "whole-session-copy.spec.ts",
      "blend-machine-order-mobile.spec.ts",
      "finish-appointment-mobile.spec.ts",
      "combined-today-workflow.spec.ts",
      "dashboard-memory-visibility.spec.ts",
      // Chloe D1: the Today treatment-memory disclosure must EXPAND without
      // navigating (it used to sit inside the row-body link and push a route),
      // while the standalone appointment-prep card keeps its full-chart link.
      // Also carries the D2/D3/D4 "this is no longer on the Dashboard" proofs.
      "dashboard-treatment-memory-inline.spec.ts",
      "before-today-imported.spec.ts",
      // Point-of-care treatment memory on the live charting screen: the
      // newest-CHARTED-session selector, the setup fields that used to be
      // missing, and the multi-area treatment-time attribution.
      "point-of-care-memory.spec.ts",
      // Repeat-client fast charting: "Start from last session" copies the
      // reusable setup and lands the practitioner in TODAY'S editor in one tap,
      // without manufacturing today's clinical outcome.
      "repeat-client-fast-charting.spec.ts",
      // 0181: a practitioner ACTIVE IN TWO STUDIOS driving the real
      // profile -> "+ Log session" -> modality journey. Every other spec in
      // this group seeds ONE studio, where the old unordered membership pick
      // was always right by construction, which is exactly how the P1 reached
      // production. This is the only fixture that can express the defect.
      "multi-studio-session-start.spec.ts",
    ],
  },
  intake: {
    description: "client intake capture and practitioner review",
    specs: [
      "intake-review-integrity.spec.ts",
      "intake-electrolysis-acknowledgement.spec.ts",
      // Practitioner-assisted completion: the practitioner records the
      // questionnaire, the client completes their own acknowledgements.
      "practitioner-assisted-intake.spec.ts",
      // The studio's real live consent forms completed inside the intake:
      // required treatment checkbox, photo Accept/Deny (both completing), and
      // the stale-template refusal.
      "intake-live-consent-forms.spec.ts",
      // Chloe's actual route (Client -> Health & Forms -> View intake): the
      // recorded intake consent AND the current portal photo status, which no
      // helper test could prove because the gap was a mounting location.
      "intake-review-consent-visibility.spec.ts",
      // The diabetes / thyroid subtype conditionals: absent until the parent
      // condition is reported, required once it is, hidden again on retraction,
      // and read back truthfully on the practitioner review grid.
      "intake-diabetes-thyroid-subtypes.spec.ts",
    ],
  },
  portal: {
    description: "client portal and tokenised links",
    specs: [
      "appointment-token-hash.spec.ts",
      // B7 / 0176: the only browser proof that a policy edited between render
      // and submit is refused, re-presented, and requires a SECOND consent.
      "public-cancel-policy-change.spec.ts",
      // PR #526: the only browser proof of the consent render -> comparand
      // -> submit chain (stale-form refusal + photo deny).
      "portal-consent-signing-integrity.spec.ts",
      "personal-notes-bullets-mobile.spec.ts",
      "pinned-note-edit-mobile.spec.ts",
    ],
  },
  booking: {
    description: "public booking and appointment lifecycle",
    specs: [
      "client-booking-outside-hours.spec.ts",
      // The calm counterpart to the spec above: a manual time INSIDE working
      // hours must book with no outside-hours language and must NOT stamp
      // booked_outside_availability. The pair proves the same control produces
      // opposite outcomes based on the real availability window.
      "manual-time-inside-availability.spec.ts",
      // 0171: the public reschedule v2 contract (policy hash, exclusion,
      // duration authority, same-time, duplicate submit, post-commit success).
      "public-reschedule-v2.spec.ts",
      "manual-override-buffer-booking.spec.ts",
      "move-appointment-custom-time.spec.ts",
      "move-appointment-mobile-submit.spec.ts",
      "move-appointment-responsive.spec.ts",
      "safe-willow-appointment-lifecycle.spec.ts",
      "create-plan-from-appointment.spec.ts",
    ],
  },
  calendar: {
    description: "calendar surfaces, services and colours",
    specs: [
      "service-calendar-color-mobile.spec.ts",
      "service-order-and-colors.spec.ts",
      "disinfectant-notification.spec.ts",
      // Appointment preparation memory on the calendar detail screen: the
      // newest-CHARTED selector at the appointment boundary, the complete
      // per-area setup + outcomes, and the full practitioner narrative.
      "appointment-prep-memory.spec.ts",
      // The practitioner week runs Sunday → Saturday, and the SAME Sunday
      // boundary drives the data range: a grid that starts Sunday while the
      // query starts Monday loses the Sunday appointment silently.
      "calendar-week-starts-sunday.spec.ts",
    ],
  },
  owner_admin: {
    description: "owner/admin, onboarding, studio setup and capacity",
    specs: [
      "invitation-reconciliation.spec.ts",
      "invite-only.spec.ts",
      // REL-001: the authenticated app-shell error boundary, including the
      // auth-gate invariants (anonymous still bounces to /login, redirect() and
      // notFound() are not converted into a generic retry screen). It sits with
      // invite-only.spec.ts because this group is where the shell/auth-gate
      // family already lives. Deliberately NOT in `smoke`: that group runs on
      // every targeted PR, and the count pinned in
      // tests/ci/browser-selection.test.ts tracks that lane's cost. Any diff
      // that can reach this boundary is unattributable application code, which
      // already fails safe to EXTENDED coverage, so the spec runs whenever it
      // matters.
      "authenticated-route-error-containment.spec.ts",
      "new-studio-wizard.spec.ts",
      "onboarding.spec.ts",
      "quick-import.spec.ts",
      "welcome-email-admin.spec.ts",
      "practitioner-availability-compat.spec.ts",
      "practitioner-booking-studio-b.spec.ts",
      "practitioner-quick-book-studio-b.spec.ts",
      "practitioner-reassignment-studio-b.spec.ts",
      "practitioner-schedule-owner.spec.ts",
      "practitioner-schedule-studio-b.spec.ts",
    ],
  },
  marketing: {
    description: "public marketing site",
    specs: ["marketing-homepage.spec.ts", "marketing-pages.spec.ts"],
  },
  responsive: {
    description: "cross-cutting responsive behaviour",
    specs: ["mobile-ux.spec.ts"],
  },
  google: {
    description: "Google Calendar surfaces (fake Google)",
    specs: ["google-calendar-connection.spec.ts", "google-calendar-integrations.spec.ts"],
  },
};

/**
 * Path → group. Order matters only for readability; all matches accumulate.
 * SHARED paths deliberately map to `EXTENDED` (everything), because a shared
 * helper can affect any workflow and filename proximity alone would miss it.
 */
export const EXTENDED = "__extended__";

const SHARED_PATTERNS = [
  // Changing CI itself can alter how every lane runs, so it must not be able
  // to narrow browser coverage. Without this a workflow change would set
  // full_matrix_required=true while selecting NO browser group: the lane
  // would be skipped exactly when the most caution is warranted.
  /^\.github\/workflows\//,
  /^scripts\/(classify-changes|browser-groups|ci-plan)\.mjs$/,
  /^e2e\/helpers\//,
  /^playwright\.config\./,
  /^lib\/supabase\//,
  /^lib\/auth\//,
  /^middleware\./,
  /^app\/layout\.tsx$/,
  /^app\/globals\.css$/,
  /^components\/(ui|layout|shell)\//,
  /^package(-lock)?\.json$/,
  /^tsconfig/,
  /^next\.config\./,
];

const PATH_TO_GROUP = [
  { group: "intake", patterns: [/intake/i] },
  { group: "portal", patterns: [/portal/i, /pinned[-_]?note/i, /personal[-_]?note/i] },
  { group: "booking", patterns: [/booking/i, /appointments?/i, /reschedule/i, /\bbook\b/i, /treatment-plans/i] },
  { group: "sessions", patterns: [/sessions?\//i, /charting/i, /electrolysis/i, /laser/i, /session[-_]?block/i, /probe/i, /observation[-_]?chip/i, /treatment[-_]?memory/i, /clinical[-_]?note/i] },
  { group: "calendar", patterns: [/calendar/i, /\bservices?\b/i, /disinfectant/i] },
  { group: "owner_admin", patterns: [/onboarding/i, /invitation/i, /invite/i, /\badmin\b/i, /practitioner/i, /studio/i, /import/i] },
  { group: "marketing", patterns: [/^app\/\(marketing\)/, /marketing/i] },
  { group: "google", patterns: [/google[-_]?calendar/i] },
  { group: "responsive", patterns: [/mobile/i, /responsive/i] },
];

/** All spec files for a set of group names, deduplicated and sorted. */
export function specsForGroups(groups) {
  if (groups.includes(EXTENDED)) return null; // null = run everything
  const out = new Set();
  for (const g of groups) {
    for (const s of BROWSER_GROUPS[g]?.specs ?? []) out.add(s);
  }
  return [...out].sort();
}

/**
 * Decide which browser groups a diff affects.
 * Returns { groups, extended, reason }.
 */
export function selectBrowserGroups(files) {
  const list = (files ?? []).map((f) => f.trim()).filter(Boolean);
  if (list.length === 0) {
    return { groups: [EXTENDED], extended: true, reason: "no detectable diff: failing safe to extended coverage" };
  }

  // Docs / ledger / migration-only never need a browser.
  const NON_BROWSER = [/^docs\//, /\.md$/, /^supabase\/migrations\//, /^tests\/(db|migrations|security|audits|scripts|ci)\//];
  if (list.every((f) => NON_BROWSER.some((re) => re.test(f)))) {
    return { groups: [], extended: false, reason: "docs / ledger / migration-only, no browser coverage needed" };
  }

  const shared = list.filter((f) => SHARED_PATTERNS.some((re) => re.test(f)));
  if (shared.length > 0) {
    return {
      groups: [EXTENDED],
      extended: true,
      reason: `shared browser/app infrastructure changed (${shared[0]}), a shared helper can affect any workflow, so filename proximity is not enough`,
    };
  }

  const groups = new Set();
  const why = [];
  for (const f of list) {
    for (const rule of PATH_TO_GROUP) {
      if (rule.patterns.some((re) => re.test(f))) {
        if (!groups.has(rule.group)) why.push(`${rule.group} <- ${f}`);
        groups.add(rule.group);
      }
    }
  }

  // A changed spec always selects its own group.
  for (const f of list) {
    const base = f.startsWith("e2e/") ? f.slice(4) : null;
    if (!base) continue;
    for (const [g, def] of Object.entries(BROWSER_GROUPS)) {
      if (def.specs.includes(base)) {
        if (!groups.has(g)) why.push(`${g} <- ${f}`);
        groups.add(g);
      }
    }
  }

  // Fail SAFE on application code we could not attribute to a group.
  //
  // This check is PER FILE, and deliberately so. It used to run only when the
  // whole diff selected ZERO groups, which meant a single co-changed file that
  // DID match a group silently cancelled the safety net for every file that did
  // not. Measured: `app/(app)/dashboard/page.tsx` alone correctly selected
  // extended, but that same file plus one calendar test selected `calendar` +
  // `smoke`, the dashboard, entirely uncovered, because something else in the
  // commit happened to be attributable.
  //
  // The doctrine this restores is the one already written down in CLAUDE.md §3:
  // "Unattributable application code fails safe to extended, NEVER to a narrow
  // group." Attributing a file narrows it on purpose; failing to attribute one
  // must never narrow it by accident.
  const unattributed = list.filter(
    (f) =>
      /^(app|components|lib|hooks)\//.test(f) &&
      !PATH_TO_GROUP.some((rule) => rule.patterns.some((re) => re.test(f))),
  );
  if (unattributed.length > 0) {
    return {
      groups: [EXTENDED],
      extended: true,
      reason: `application code changed that matches no browser group (${unattributed[0]}), failing safe to extended coverage`,
    };
  }

  if (groups.size === 0) {
    return { groups: [], extended: false, reason: "no browser-affecting paths" };
  }

  // Smoke always accompanies a targeted run: it is the cheapest proof the app
  // still boots and authenticates before the targeted specs are believed.
  groups.add("smoke");
  return { groups: [...groups].sort(), extended: false, reason: why.join("; ") };
}

if (process.argv[1] && process.argv[1].endsWith("browser-groups.mjs")) {
  const files = process.argv.slice(2);
  const r = selectBrowserGroups(files);
  console.log(JSON.stringify({ ...r, specs: specsForGroups(r.groups) }, null, 2));
}
