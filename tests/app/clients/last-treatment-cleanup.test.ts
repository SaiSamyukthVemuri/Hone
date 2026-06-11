import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickLastTreatment } from "@/lib/sessions/clinical-summary";

// PR #199: Last Treatment + charting redundancy + client info cleanup.
//
// 1. The Sessions-tab top card shows the most recent CHARTED treatment
//    (never a newer empty session), labeled "Last treatment".
// 2. One "For next visit" surface: the per-area inputs are gone; the
//    session-level note is the single place to write next-visit
//    instructions. Old area-level caution data still round-trips.
// 3. One "Performed by" surface: the inline line under the session
//    title (with an Edit affordance); the separate card is gone.
// 4. "Detach from this plan" renders INSIDE the treatment plan card.
// 5. Client info shows Birthday as a plain row: no nested box, no
//    "Used only for practitioner reminders" helper, one Edit link.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const PAGE = read("app/(app)/clients/[id]/page.tsx");
const SESSION_PAGE = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
);
const FORM = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
);
const NOTE_FORM = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/NextVisitNoteForm.tsx",
);
const PERFORMER_LINE = read("components/session-performer-line.tsx");
const BANNER = read("components/treatment-plan-banner.tsx");
const ATTACHMENT = read("components/treatment-plan-attachment.tsx");
const BIRTHDAY = read("components/client-birthday-card.tsx");
const SUMMARY = read("components/last-session-summary.tsx");

// ---------------------------------------------------------------------------
// 1. Last treatment selection (pure helper, behavioral)
// ---------------------------------------------------------------------------

type Candidate = {
  id: string;
  electrolysis_entries: ReadonlyArray<unknown>;
  laser_entries: ReadonlyArray<unknown>;
};

function session(
  id: string,
  opts: { electro?: number; laser?: number } = {},
): Candidate {
  return {
    id,
    electrolysis_entries: Array.from({ length: opts.electro ?? 0 }, () => ({})),
    laser_entries: Array.from({ length: opts.laser ?? 0 }, () => ({})),
  };
}

describe("pickLastTreatment: most recent session with actual treatment details", () => {
  it("newest session has no entries/areas; the older charted session wins", () => {
    const newestEmpty = session("new");
    const olderCharted = session("old");
    const blocks = new Map([["old", [{}, {}]]]);
    expect(pickLastTreatment([newestEmpty, olderCharted], blocks)).toBe(
      olderCharted,
    );
  });

  it("newest session has treatment areas; it wins", () => {
    const newest = session("new");
    const older = session("old");
    const blocks = new Map([
      ["new", [{}]],
      ["old", [{}]],
    ]);
    expect(pickLastTreatment([newest, older], blocks)).toBe(newest);
  });

  it("no charted sessions at all returns null (empty state)", () => {
    expect(
      pickLastTreatment([session("a"), session("b")], new Map()),
    ).toBeNull();
  });

  it("legacy sessions qualify via raw electrolysis/laser entries", () => {
    const newestEmpty = session("new");
    const legacyElectro = session("e", { electro: 3 });
    expect(pickLastTreatment([newestEmpty, legacyElectro], new Map())).toBe(
      legacyElectro,
    );
    const legacyLaser = session("l", { laser: 1 });
    expect(pickLastTreatment([newestEmpty, legacyLaser], new Map())).toBe(
      legacyLaser,
    );
  });

  it("an empty blocks list does not count as charted", () => {
    const newest = session("new");
    const older = session("old", { electro: 1 });
    const blocks = new Map([["new", [] as ReadonlyArray<unknown>]]);
    expect(pickLastTreatment([newest, older], blocks)).toBe(older);
  });
});

describe("Last treatment card (Sessions tab)", () => {
  it("the heading is Last treatment and the page wires the helper", () => {
    expect(PAGE).toMatch(/>Last treatment<\/h2>/);
    expect(PAGE).not.toMatch(/>Last session<\/h2>/);
    expect(PAGE).toMatch(/pickLastTreatment\(recentSessions, blocksBySession\)/);
  });

  it("blocks are read across the recent sessions, not just sessions[0]", () => {
    expect(PAGE).toMatch(/\.in\(\s*"session_id",\s*recentSessions\.map/);
  });

  it("a newer uncharted session is called out, not allowed to blank the card", () => {
    expect(PAGE).toMatch(/Most recent charted treatment/);
    expect(PAGE).toMatch(/lastTreatment\.id !== sessions\[0\]\?\.id/);
  });

  it("empty state says no charted treatments yet; 'No entries logged' is gone", () => {
    expect(PAGE).toMatch(/No charted treatments yet\./);
    expect(PAGE).not.toMatch(/No entries logged/);
  });

  it("the card shows date, modality, performer, per-area summary, watch/plan, and Open", () => {
    expect(PAGE).toMatch(/<FormattedDateTime iso=\{lastTreatment\.started_at\}/);
    expect(PAGE).toMatch(/\{lastTreatment\.modality\}/);
    expect(PAGE).toMatch(/lastTreatmentPerformer/);
    expect(PAGE).toMatch(/<AreaSummaries summary=\{lastTreatmentSummary\}/);
    expect(PAGE).toMatch(
      /<FromLastVisitForToday[\s\S]{0,40}summary=\{lastTreatmentSummary\}/,
    );
    expect(PAGE).toMatch(
      /href=\{`\/clients\/\$\{client\.id\}\/sessions\/\$\{lastTreatment\.id\}`\}/,
    );
    // Settings / Probe / Tolerance / Watch / Plan all come from the
    // shared summary components the card renders.
    expect(SUMMARY).toMatch(/Settings/);
    expect(SUMMARY).toMatch(/Probe/);
    expect(SUMMARY).toMatch(/Tolerance/);
    expect(SUMMARY).toMatch(/Watch:<\/span>/);
    expect(SUMMARY).toMatch(/Plan:<\/span>/);
  });
});

// ---------------------------------------------------------------------------
// 2. One "For next visit" surface
// ---------------------------------------------------------------------------

describe("For next visit consolidation", () => {
  it("the treatment-area form no longer renders an area-level For next visit section", () => {
    expect(FORM.indexOf(">For next visit<")).toBe(-1);
  });

  it("the treatment-area form no longer renders the caution checkbox", () => {
    expect(FORM).not.toMatch(/type="checkbox"[\s\S]{0,120}cautionForNextSession/);
    expect(FORM).not.toMatch(/Caution for next session/);
  });

  it("saved area-level caution data still loads and saves back unchanged", () => {
    expect(FORM).toMatch(
      /cautionForNextSession: block\.caution_for_next_session \?\? false/,
    );
    expect(FORM).toMatch(/cautionNote: block\.caution_note \?\? ""/);
    expect(FORM).toMatch(
      /cautionForNextSession: draft\.cautionForNextSession/,
    );
    expect(FORM).toMatch(/cautionNote: draft\.cautionNote\.trim\(\) \|\| null/);
  });

  it("old caution data still renders read-only via the From last visit watch lines", () => {
    const SUMMARY_HELPER = read("lib/sessions/clinical-summary.ts");
    expect(SUMMARY_HELPER).toMatch(/caution_for_next_session/);
    expect(SUMMARY_HELPER).toMatch(/watchLines/);
  });

  it("the session-level For next visit section renders exactly once with the new copy", () => {
    expect(
      SESSION_PAGE.match(/>For next visit<\/h2>/g)?.length,
    ).toBe(1);
    expect(SESSION_PAGE).toMatch(
      /Anything to remember, watch, or do differently next time\./,
    );
    expect(NOTE_FORM).toMatch(
      /e\.g\. Upper lip: start lower and check sensitivity\. Chin: continue same settings\./,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. One "Performed by" surface
// ---------------------------------------------------------------------------

describe("Performed by appears once on the session page", () => {
  it("the session page renders the inline performer line and no separate card", () => {
    expect(SESSION_PAGE.match(/<SessionPerformerLine/g)?.length).toBe(1);
    expect(SESSION_PAGE).not.toMatch(/SessionInfoCard/);
    expect(SESSION_PAGE).not.toMatch(/Performed by \{performerName\}/);
  });

  it("the line shows the performer and an Edit affordance backed by the same action", () => {
    expect(PERFORMER_LINE).toMatch(/Performed by/);
    expect(PERFORMER_LINE).toMatch(/>\s*Edit\s*</);
    expect(PERFORMER_LINE).toMatch(/updatePerformerAction/);
    expect(SESSION_PAGE).toMatch(
      /updatePerformerAction=\{updateSessionPerformerAction\}/,
    );
  });

  it("the old separate card component is gone from the repo", () => {
    expect(() => read("components/session-info-card.tsx")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Detach lives inside the treatment plan card
// ---------------------------------------------------------------------------

describe("Detach from this plan lives inside the plan card", () => {
  it("the banner accepts a detachSlot and renders it inside its section", () => {
    expect(BANNER).toMatch(/detachSlot\?: ReactNode/);
    expect(BANNER).toMatch(/\{detachSlot && <div className="mt-2">\{detachSlot\}<\/div>\}/);
  });

  it("the session page passes the attachment widget into the banner when attached", () => {
    expect(SESSION_PAGE).toMatch(/detachSlot=\{\s*<TreatmentPlanAttachment/);
  });

  it("the detach affordance no longer floats right/outside the card", () => {
    expect(ATTACHMENT).toMatch(/Detach from this plan/);
    expect(ATTACHMENT).not.toMatch(/-mt-1 flex flex-col items-end/);
  });
});

// ---------------------------------------------------------------------------
// 5. Client info: birthday as a plain row
// ---------------------------------------------------------------------------

describe("Client info birthday row", () => {
  it("no nested card/box: the birthday section has no border of its own", () => {
    expect(BIRTHDAY).not.toMatch(/rounded-lg border/);
  });

  it("the reminders helper text is gone", () => {
    expect(BIRTHDAY).not.toMatch(/Used only for practitioner reminders/);
  });

  it("birthday, emergency contact, and address are sibling rows in one card", () => {
    const card = PAGE.slice(
      PAGE.indexOf("Client info"),
      PAGE.lastIndexOf("Pricing"),
    );
    const birthday = card.indexOf("<ClientBirthdayCard");
    const emergency = card.indexOf("Emergency contact");
    const address = card.indexOf("Address");
    expect(birthday).toBeGreaterThan(-1);
    expect(emergency).toBeGreaterThan(birthday);
    expect(address).toBeGreaterThan(emergency);
    // The row uses the same label style as its siblings.
    expect(BIRTHDAY).toMatch(
      /uppercase tracking-wider text-neutral-500">\s*Birthday/,
    );
  });

  it("one Edit affordance for the card; the row keeps no inline editor", () => {
    const card = PAGE.slice(
      PAGE.indexOf("Client info"),
      PAGE.lastIndexOf("Pricing"),
    );
    expect(card).toMatch(/\/clients\/\$\{client\.id\}\/edit/);
    expect(BIRTHDAY).not.toMatch(/<form/);
    expect(BIRTHDAY).not.toMatch(/birthday_year/);
    // The display still surfaces a stored real year.
    expect(BIRTHDAY).toMatch(/realYear/);
  });

  it("overview order holds: pinned notes, allergies, skin, client info, pricing", () => {
    const overview = PAGE.slice(
      PAGE.indexOf('{activeTab === "overview"'),
      PAGE.indexOf('{activeTab === "messages"'),
    );
    const pinned = overview.indexOf("ClientPinnedNotesCard");
    const allergies = overview.indexOf("Allergies");
    const skin = overview.indexOf(">\n              Skin");
    const info = overview.indexOf("Client info");
    const pricing = overview.lastIndexOf("Pricing");
    expect(pinned).toBeGreaterThan(-1);
    expect(allergies).toBeGreaterThan(pinned);
    expect(skin).toBeGreaterThan(allergies);
    expect(info).toBeGreaterThan(skin);
    expect(pricing).toBeGreaterThan(info);
  });
});
