import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import type { MachineProfile } from "@/lib/machines/profile-contract";
import type { RecordedReading } from "@/lib/machines/machine-queries";

// ===========================================================================
// WHAT HAS ALREADY BEEN RECORDED ON THIS TREATMENT — the render.
//
// Run through react-dom/server rather than grepped, which is the idiom this
// repo uses for render contracts, and the only way to prove copy here: there
// is no jsdom, so a mounted browser is the alternative.
//
// WHAT IT CLOSES. A recorded capture was permanent and INVISIBLE: nothing read
// what had already been recorded against the block being charted, so after a
// page load the practitioner saw nothing and could only re-record - appending
// a second immutable capture indistinguishable from a genuine mid-treatment
// change - or guess. Both reads existed, granted and proved against Postgres,
// and neither reached a screen.
//
// THE COPY'S LIMITS ARE `changesWithin`'s REFUSALS, not this component's
// opinion, which is why the word "changed" cannot overclaim however it is
// phrased: that function never pairs the same field across groups, across
// modes or profile versions, or a field re-read at the same value.
//
// Synthetic records only. Nothing here corresponds to anything real.
// ===========================================================================

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MachinePriorSetup } = await import(
  "@/components/machines/machine-prior-setup"
);
const { MachineRecordedSetups } = await import(
  "@/components/machines/machine-recorded-setups"
);

const PROFILE: MachineProfile = {
  profileId: "fixture:recorded",
  version: 2,
  family: "Synthetic/Demo",
  manufacturer: "Fixture",
  model: "Recorded",
  availability: "active",
  verification: "device-confirmed",
  frequency: { kind: "not-applicable" },
  channels: { kind: "independent", count: 4 },
  evidence: [],
  modes: [
    {
      key: "galvanic",
      nativeLabel: "Galvanic",
      stages: [],
      fields: [
        {
          key: "current",
          nativeLabel: "Current",
          unit: "µA",
          decimals: 0,
          quantity: "current",
          scope: "per-channel",
          optional: false,
          editable: true,
          source: "practitioner-entered",
          advisory: [],
        },
        {
          key: "duration",
          nativeLabel: "Time",
          unit: "s",
          decimals: 1,
          quantity: "duration",
          scope: "per-channel",
          optional: false,
          editable: true,
          source: "practitioner-entered",
          advisory: [],
        },
      ],
    },
  ],
} as unknown as MachineProfile;

const CAT = [PROFILE];

/** A locale-formatted clock time, in any of the shapes Intl produces. */
const CLOCK = /\d{1,2}:\d{2}\s?(AM|PM|am|pm)?/;

const base = {
  blockId: "block-1",
  deviceId: "dev-1",
  profileId: "fixture:recorded",
  profileVersion: 2,
  modeKey: "galvanic",
  stageKey: null,
  nativeUnit: "µA",
  decimals: 0,
};

function reading(o: {
  captureId?: string | null;
  groupKey?: string;
  revision?: number;
  recordedAt: string;
  fieldKey?: string;
  value?: number;
  absent?: "not-recorded" | "not-applicable" | "not-legible";
  channels?: number[];
  profileVersion?: number;
  nativeUnit?: string;
  decimals?: number;
}): RecordedReading {
  return {
    ...base,
    captureId: o.captureId === undefined ? "cap-1" : o.captureId,
    groupKey: o.groupKey ?? "g1",
    revision: o.revision ?? 1,
    recordedAt: o.recordedAt,
    fieldKey: o.fieldKey ?? "current",
    channels: o.channels ?? [],
    profileVersion: o.profileVersion ?? base.profileVersion,
    nativeUnit: o.nativeUnit ?? base.nativeUnit,
    decimals: o.decimals ?? base.decimals,
    value:
      o.absent !== undefined
        ? { kind: "absent", reason: o.absent }
        : { kind: "value", value: o.value ?? 120 },
  } as RecordedReading;
}

const render = (props: {
  readings: RecordedReading[];
  catalogue?: readonly MachineProfile[];
  unitNames?: Record<string, string>;
  /** The read FAILED — rendered distinctly from an empty treatment. */
  unavailable?: boolean;
}) =>
  renderToStaticMarkup(
    createElement(MachineRecordedSetups, {
      catalogue: CAT,
      ...props,
    }),
  );

describe("with nothing recorded", () => {
  it("renders NOTHING AT ALL, not an empty section", () => {
    // A heading over no content reads as a surface that failed to load, which
    // is the opposite of the reassurance this exists to give.
    expect(render({ readings: [] })).toBe("");
  });
});

describe("one capture", () => {
  const html = render({
    readings: [
      reading({ recordedAt: "2026-10-14T14:00:00Z", fieldKey: "current", value: 120 }),
      reading({
        recordedAt: "2026-10-14T14:00:00Z",
        fieldKey: "duration",
        value: 300.5,
        nativeUnit: "s",
        decimals: 1,
      }),
    ],
    unitNames: { "dev-1": "Room 1 unit" },
  });

  it("says it is THIS treatment, not a previous one", () => {
    // The whole reason it is a separate surface from Previous treatment: that
    // panel answers "what did I do last time" and is reference; this is the
    // record of today.
    expect(html).toContain('data-testid="machine-recorded-setups"');
    expect(html).toContain("Recorded this treatment");
    expect(html).not.toContain("Previous treatment");
    expect(html).not.toMatch(/reference only/i);
  });

  it("states that a capture is PERMANENT, which is what decides what she does next", () => {
    // "Record it again to fix it" does not fix anything - it appends. Saying
    // so is what makes recording a genuine change legible as a different act.
    expect(html).toContain('data-testid="recorded-setups-note"');
    expect(html).toMatch(/permanent/i);
    expect(html).toMatch(/cannot be edited/i);
    expect(html).toMatch(/One capture is recorded/);
  });

  it("shows the machine's OWN labels and units", () => {
    expect(html).toContain("Current");
    expect(html).toContain("µA");
    // The profile's own word for duration, not the quantity's.
    expect(html).toContain("Time");
    expect(html).toContain("300.5");
    expect(html).toContain("120");
  });

  it("shows the TIME OF DAY of that capture", () => {
    // Deliberately unlike machine-prior-setup, which shows a date and no
    // clock time because it renders several groups under one heading. Every
    // entry here is ONE capture with its OWN instant, and the time is what
    // distinguishes a change made twenty minutes ago from the starting setup.
    expect(html).toContain('data-testid="recorded-capture-when"');
    // THE TEXT IS A BROWSER FACT NOW (Codex, #860 4309128374). This asserted a
    // clock pattern in the SERVER markup, which was the defect itself: the
    // string came from the runtime's default locale and timezone, so Node and
    // the practitioner's browser produced different text and, near midnight, a
    // different DAY. `FormattedDateTime` renders nothing server-side on
    // purpose, so the server-side property is that the SLOT exists and carries
    // no instant for a client render to disagree with.
    expect(
      html,
      "a locale-formatted clock time was rendered on the SERVER, which is the hydration hazard",
    ).not.toMatch(CLOCK);
  });

  it("names the physical unit the studio knows", () => {
    expect(html).toContain("Room 1 unit");
    // Never the bare id - a uuid is noise to a practitioner.
    expect(html).not.toContain("dev-1");
  });

  it("shows NO unit at all when the studio has no name for it", () => {
    // THE ASSERTION ABOVE CANNOT CATCH THIS, and a negative control proved it:
    // that case supplies a name, so the fallback is never taken and swapping
    // `?? null` for `?? entry.deviceId` left the suite green. The claim is
    // about the UNNAMED case, so it needs a fixture with no names - without
    // this, "never the bare id" was an assertion about a branch no test ran.
    const unnamed = render({
      readings: [reading({ recordedAt: "2026-10-14T14:00:00Z", value: 120 })],
    });
    expect(unnamed).toContain('data-testid="machine-recorded-setups"');
    expect(unnamed, "a bare device id reached the practitioner").not.toContain(
      "dev-1",
    );
    // The reading is still shown; only the unit's name is absent.
    expect(unnamed).toContain("120");
  });

  it("does NOT label a first capture as a revision", () => {
    // "capture 1" is noise. The number only means something once there is an
    // earlier one.
    expect(html).not.toMatch(/capture 1\b/);
  });

  it("shows no CHANGED section when nothing changed", () => {
    expect(html).not.toContain('data-testid="recorded-changes"');
    expect(html).not.toContain("Changed during this treatment");
  });
});

describe("two setting groups of one save", () => {
  const at = "2026-10-14T14:00:00Z";
  const html = render({
    readings: [
      reading({ captureId: "cap-a", groupKey: "g1", channels: [1, 2], recordedAt: at, value: 120 }),
      reading({ captureId: "cap-b", groupKey: "g2", channels: [3, 4], recordedAt: at, value: 80 }),
    ],
  });

  it("renders TWO entries, never one", () => {
    // They are two facts. Merging them would assert she ran both probe sets at
    // one setting.
    expect(html).toContain('data-testid="recorded-capture-g1-1"');
    expect(html).toContain('data-testid="recorded-capture-g2-1"');
    expect(html).toMatch(/2 captures are recorded/);
  });

  it("keeps each group's channels with its own values", () => {
    expect(html).toContain("Channels 1, 2");
    expect(html).toContain("Channels 3, 4");
  });

  it("does NOT call one probe's setting a change in the other's", () => {
    // changesWithin refuses to pair the same field across groups, so this
    // cannot claim it however the line is phrased.
    expect(html).not.toContain('data-testid="recorded-changes"');
  });
});

describe("a setting changed during the treatment", () => {
  const html = render({
    readings: [
      reading({ captureId: "cap-1", revision: 1, recordedAt: "2026-10-14T14:00:00Z", value: 120 }),
      reading({ captureId: "cap-2", revision: 2, recordedAt: "2026-10-14T14:30:00Z", value: 150 }),
    ],
  });

  it("names the change, both values, and when", () => {
    expect(html).toContain('data-testid="recorded-changes"');
    expect(html).toContain("Changed during this treatment");
    expect(html).toContain('data-testid="recorded-change-g1-current"');
    expect(html).toContain("120");
    expect(html).toContain("150");
    // As above: the slot, not the text.
    expect(
      html,
      "a locale-formatted clock time was rendered on the SERVER",
    ).not.toMatch(CLOCK);
  });

  it("marks the later capture as a revision, and keeps the earlier one", () => {
    // Append-only is the clinical contract of this table, and the surface has
    // to show it rather than replacing the first value with the second.
    expect(html).toContain('data-testid="recorded-capture-g1-1"');
    expect(html).toContain('data-testid="recorded-capture-g1-2"');
    expect(html).toMatch(/capture 2/);
  });

  it("prints each side's OWN recorded unit", () => {
    // Not one of them applied to both, and never the catalogue's: a profile
    // version change can move the unit, and where it has, changesWithin
    // refuses to pair the readings at all.
    const line = html.slice(html.indexOf('data-testid="recorded-change-g1-current"'));
    const upto = line.slice(0, line.indexOf("</li>"));
    expect((upto.match(/µA/g) ?? []).length).toBe(2);
  });
});

describe("a setting RE-READ at the same value", () => {
  const html = render({
    readings: [
      reading({ captureId: "cap-1", revision: 1, recordedAt: "2026-10-14T14:00:00Z", value: 120 }),
      reading({ captureId: "cap-2", revision: 2, recordedAt: "2026-10-14T14:30:00Z", value: 120 }),
    ],
  });

  it("shows BOTH captures, because both are in the record", () => {
    expect(html).toContain('data-testid="recorded-capture-g1-1"');
    expect(html).toContain('data-testid="recorded-capture-g1-2"');
  });

  it("does NOT call it a change", () => {
    // She re-read the machine and it still said 120. Calling that an
    // adjustment invents one she did not make.
    expect(html).not.toContain('data-testid="recorded-changes"');
    expect(html).not.toContain("Changed during this treatment");
  });
});

describe("a capture recorded under an older field contract", () => {
  const html = render({
    readings: [
      reading({
        recordedAt: "2026-10-14T14:00:00Z",
        profileVersion: 1,
        fieldKey: "current",
        value: 120,
        nativeUnit: "mA",
      }),
    ],
  });

  it("shows the RECORDED key, not today's label", () => {
    // Relabelling an old number with a newer contract's words is how a record
    // quietly starts lying.
    expect(html).toContain("current");
    expect(html).not.toContain(">Current<");
  });

  it("shows the RECORDED unit, not the catalogue's", () => {
    expect(html).toContain("mA");
    expect(html).not.toContain("µA");
  });

  it("says the contract has changed, so the keys are explained", () => {
    expect(html).toMatch(/field contract has changed/i);
  });
});

describe("an absence is rendered as what it is", () => {
  it("names the reason rather than printing a number", () => {
    const html = render({
      readings: [reading({ recordedAt: "2026-10-14T14:00:00Z", absent: "not-legible" })],
    });
    expect(html).toContain("not legible");
    expect(html).not.toMatch(/\b120\b/);
  });
});

describe("a reading with NO capture id", () => {
  it("is still shown, and separate captures are not merged", () => {
    // A null capture id is a reading recorded before captures existed. It is a
    // historical fact, not missing data, and it must not vanish from the
    // surface that tells her what is recorded.
    const html = render({
      readings: [
        reading({ captureId: null, revision: 1, recordedAt: "2026-10-14T13:00:00Z", value: 100 }),
        reading({ captureId: null, revision: 2, recordedAt: "2026-10-14T13:30:00Z", value: 110 }),
      ],
    });
    expect(html).toContain('data-testid="recorded-capture-g1-1"');
    expect(html).toContain('data-testid="recorded-capture-g1-2"');
    expect(html).toMatch(/2 captures are recorded/);
  });
});

describe("the unit sentinels are never printed as if they were units", () => {
  // `device-display` and `none` are the contract's way of saying "this machine
  // has no unit for this field" - a 5HD's UE, an ST 350's UL. The entry form
  // has always honoured that through `unitLabel`; this surface printed the
  // sentinel verbatim, so one reading rendered "1.25" in the form above and
  // "1.25 device-display" in the history below it (Codex, #860 4288424526).
  //
  // RENDERED, not grepped: the claim is about what reaches a screen, and the
  // repo has no jsdom, so react-dom/server is the honest alternative to
  // mounting a browser for it.

  it("renders a device-display reading with its value and NO unit", () => {
    const html = render({
      readings: [
        reading({
          recordedAt: "2026-10-14T14:00:00Z",
          fieldKey: "current",
          value: 125,
          nativeUnit: "device-display",
          decimals: 2,
        }),
      ],
    });
    expect(html, "the sentinel reached the screen").not.toContain("device-display");
    expect(html, "the value must survive the repair").toMatch(/125/);
  });

  it("renders a `none` reading the same way", () => {
    const html = render({
      readings: [
        reading({ recordedAt: "2026-10-14T14:00:00Z", value: 7, nativeUnit: "none" }),
      ],
    });
    // SCOPED, because "none" is a common English word and a blanket
    // `not.toContain("none")` would pass or fail for reasons unrelated to the
    // unit - the markup legitimately contains class names and copy using it.
    expect(html).not.toMatch(/>\s*none\s*</);
    expect(html).toMatch(/\b7\b/);
  });

  it("CONTROL: a real unit is still printed, including a historical one", () => {
    // The repair must not become "print no units". A unit today's catalogue
    // no longer declares is still what the record says, and harmonising it
    // would destroy the native precision the contract exists to preserve.
    const html = render({
      readings: [
        reading({ recordedAt: "2026-10-14T14:00:00Z", value: 5, nativeUnit: "ms" }),
      ],
    });
    expect(html).toContain("ms");
  });

  it("applies it to the CHANGE summary too, which had the same defect", () => {
    // Two captures of one field at different values pair into a change line,
    // and that line prints BOTH sides' recorded units. It read
    // "1.1 device-display -> 1.4 device-display" before this.
    const html = render({
      readings: [
        reading({
          captureId: "cap-1",
          revision: 1,
          recordedAt: "2026-10-14T13:00:00Z",
          fieldKey: "current",
          value: 110,
          nativeUnit: "device-display",
        }),
        reading({
          captureId: "cap-2",
          revision: 2,
          recordedAt: "2026-10-14T13:30:00Z",
          fieldKey: "current",
          value: 140,
          nativeUnit: "device-display",
        }),
      ],
    });
    expect(html).toContain('data-testid="recorded-changes"');
    expect(html, "the change line printed the sentinel").not.toContain(
      "device-display",
    );
    // The change itself must still be legible, or the assertion above could
    // pass because nothing rendered at all.
    expect(html).toMatch(/110/);
    expect(html).toMatch(/140/);
  });
});

describe("a failed read is not the same as nothing recorded", () => {
  // THE DEFECT (Codex, #860 4290452722). A failed `readingsForBlock` became
  // `[]` in the loader, so this surface rendered NOTHING - and nothing is the
  // message "you have recorded nothing on this treatment". That invites her to
  // record again, appending a second immutable capture indistinguishable from
  // a genuine mid-treatment change: the exact outcome this component exists to
  // prevent, reached through its own absence.

  it("says the record could not be read, instead of rendering nothing", () => {
    const html = render({ readings: [], unavailable: true });
    expect(html).toContain('data-testid="machine-recorded-setups-unavailable"');
    expect(html).toMatch(/could not be read/i);
  });

  it("warns against re-entering, which is the decision at stake", () => {
    // The copy has one job: stop a duplicate capture. It must say that a
    // failed read is NOT an empty one, and that a capture appends.
    const html = render({ readings: [], unavailable: true });
    expect(html).toMatch(/NOT the same as nothing being recorded/i);
    expect(html).toMatch(/appends/i);
  });

  it("is DISTINGUISHABLE from the empty case, which still renders nothing", () => {
    // The two states must not collapse into one another in either direction.
    const empty = render({ readings: [] });
    expect(empty).toBe("");
    const failed = render({ readings: [], unavailable: true });
    expect(failed).not.toBe("");
  });

  it("CONTROL: a successful read with captures is unaffected", () => {
    // The unavailable branch is checked FIRST, so a bug there could swallow
    // the ordinary case.
    const html = render({
      readings: [reading({ recordedAt: "2026-10-14T14:00:00Z", value: 120 })],
    });
    expect(html).toContain('data-testid="machine-recorded-setups"');
    expect(html).not.toContain("machine-recorded-setups-unavailable");
    expect(html).toMatch(/120/);
  });
});

// ---------------------------------------------------------------------------
// MPX-03 · PREVIOUS TREATMENT: a failed read is not "no previous treatment"
//
// Found by enumerating every place a failed read became an empty list, after
// Codex reported the same conflation on the recorded-history surface
// (#860 4300759932). Different harm, same rule: she is told this client has
// never been treated on a machine, so she charts without reference to
// settings that exist and that she would otherwise have worked from.
// ---------------------------------------------------------------------------
describe("MachinePriorSetup · the guidance read failed", () => {
  const priorRender = (props: {
    readings: RecordedReading[];
    unavailable?: boolean;
    unitNames?: Record<string, string>;
  }) =>
    renderToStaticMarkup(
      createElement(MachinePriorSetup, { catalogue: CAT, ...props }),
    );

  it("says it could not load, instead of rendering nothing", () => {
    const html = priorRender({ readings: [], unavailable: true });
    expect(html).toContain('data-testid="machine-prior-setup-unavailable"');
    expect(html).toMatch(/could not be loaded/i);
  });

  it("says outright that this does NOT mean there are none", () => {
    // The whole point: silence here is read as "no previous treatment".
    const html = priorRender({ readings: [], unavailable: true });
    expect(html).toMatch(/does NOT mean there are none/i);
  });

  it("is DISTINGUISHABLE from the empty case, in both directions", () => {
    expect(priorRender({ readings: [] })).toBe("");
    expect(priorRender({ readings: [], unavailable: true })).not.toBe("");
  });

  it("CONTROL: a successful read with readings is unaffected", () => {
    // The unavailable branch is checked FIRST, so a bug there could swallow
    // the ordinary case.
    const html = priorRender({ readings: [reading({ recordedAt: "2026-10-14T14:00:00Z", value: 120 })] });
    expect(html).toContain('data-testid="machine-prior-setup"');
    expect(html).not.toContain("machine-prior-setup-unavailable");
  });
});

// ---------------------------------------------------------------------------
// MPX-03 · HOW THE READING WAS OBTAINED IS PART OF THE RECORD
//
// Codex #860 4301669064: `observation_source` was written, emitted by the SQL
// and preserved by the query, and then consumed by NEITHER clinical surface.
// So a value the practitioner ESTIMATED and a value transcribed off the
// machine's own display rendered identically. They are different clinical
// facts about the same number, and the weaker one is the one that was hidden.
//
// SHOWN FOR EVERY SOURCE, not only when it disagrees with the contract.
// Deciding "disagrees" would mean reading the expectation off TODAY'S
// contract, which is what the finding says not to do — a contract can be
// republished at a new version, and a historical row's provenance must not
// change meaning because the model's current description did.
// ---------------------------------------------------------------------------
describe("the recorded source is shown, not inferred", () => {
  const sourced = (source: string | null): RecordedReading[] => [
    {
      ...reading({ recordedAt: "2026-10-16T10:00:00Z" }),
      observationSource: source,
    } as RecordedReading,
  ];

  it("an ESTIMATED value says so", () => {
    const html = render({ readings: sourced("estimated") });
    expect(html).toContain('data-testid="recorded-source-current"');
    expect(html).toMatch(/estimated/i);
  });

  it("and is DISTINGUISHABLE from one read off the machine", () => {
    // The whole finding in one assertion: before this, these two produced
    // identical markup.
    const estimated = render({ readings: sourced("estimated") });
    const displayed = render({ readings: sourced("machine-displayed") });
    expect(estimated).not.toBe(displayed);
    expect(displayed).toMatch(/from the machine display/i);
  });

  it("a row from before the column existed invents nothing", () => {
    // Null means "not known", and a backfilled guess in a clinical record is
    // worse than a blank.
    expect(render({ readings: sourced(null) })).not.toContain(
      "recorded-source-current",
    );
  });

  it("an UNKNOWN source renders nothing rather than something wrong", () => {
    expect(render({ readings: sourced("telepathy") })).not.toContain(
      "recorded-source-current",
    );
  });

  it("PREVIOUS TREATMENT carries the same rule", () => {
    // Codex named the recorded history. The guidance surface dropped it too,
    // and there the stakes are reproduction: reproducing an ESTIMATE as
    // though it were a machine reading is the error worth preventing.
    const html = renderToStaticMarkup(
      createElement(MachinePriorSetup, {
        catalogue: CAT,
        readings: sourced("estimated"),
      }),
    );
    expect(html).toContain('data-testid="prior-source-current"');
    expect(html).toMatch(/estimated/i);
  });
});

// ---------------------------------------------------------------------------
// MPX-03 · THE SAME SETUP IS NOT TWO DIFFERENT DAYS
//
// Codex #860 4301722743: the heading formatted `recordedAt` with
// `toLocaleDateString` and the footer with `toISOString()`. For a capture
// near midnight UTC a practitioner in a negative offset saw "Oct 16, 2026"
// above and "Recorded 2026-10-17" beneath it, for ONE setup — which reads as
// two visits on a clinical record.
// ---------------------------------------------------------------------------
describe("the prior-setup date agrees with itself", () => {
  const nearMidnightUtc = "2026-10-17T02:30:00Z";

  const renderAt = (recordedAt: string) =>
    renderToStaticMarkup(
      createElement(MachinePriorSetup, {
        catalogue: CAT,
        readings: [
          { ...reading({ recordedAt }), observationSource: null } as RecordedReading,
        ],
      }),
    );

  it("renders NO day on the server, so there is none to disagree with", () => {
    // THE AGREEMENT IS STRUCTURAL NOW (Codex, #860 4309128374).
    //
    // 4301722743 made the heading and footer agree by sharing one
    // locale-formatted string. That string was itself the hazard: it came from
    // the RUNTIME's default locale and timezone, so Node and the
    // practitioner's browser produced different text and, for THIS VERY
    // instant, a different DAY. Both places now render the same validated iso
    // through the same component, which renders nothing at all server-side.
    //
    // THE LIMIT, STATED: a server-versus-client comparison is not observable
    // in one process, so what is asserted is the ABSENCE of a server-rendered
    // day - which is what makes a mismatch impossible rather than unlikely.
    // The browser-side rendering is covered where a second locale exists: the
    // fr-CA charting probe in e2e/point-of-care-memory.spec.ts.
    const html = renderAt(nearMidnightUtc);
    expect(html, "the date slot was dropped entirely").toContain(
      'data-testid="prior-setup-when"',
    );
    expect(html).toContain("Recorded ");
    // Neither "2026-10-17", nor "17/10/2026", nor "Oct 17, 2026".
    expect(
      html,
      "a day was rendered on the SERVER, which is the hydration hazard itself",
    ).not.toMatch(
      /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]{2} \d{1,2}, \d{4}/,
    );
  });

  it("and the two places render the SAME validated instant, so they cannot drift", () => {
    // What 4301722743 was protecting, asserted at the source now that the
    // rendered text is deliberately absent: one validated iso, used twice,
    // and no local formatting left in the component.
    const src = readFileSync(
      nodePath.resolve(
        __dirname,
        "../..",
        "components/machines/machine-prior-setup.tsx",
      ),
      "utf8",
    )
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(
      (
        src.match(
          /<FormattedDateTime iso=\{recordedIso\} format="date" \/>/g,
        ) ?? []
      ).length,
      "the heading and footer no longer render the same validated instant",
    ).toBe(2);
    expect(src, "the component formats an instant itself again").not.toMatch(
      /toLocale(Date|Time)?String/,
    );
  });

  it("an unreadable timestamp renders a phrase, not a crash", () => {
    // `new Date(invalid).toISOString()` throws a RangeError; the shared
    // value is simply null. This is latent-throw cover, not cosmetics.
    expect(() => renderAt("not-a-date")).not.toThrow();
    expect(renderAt("not-a-date")).toContain("Recorded earlier");
  });
});

// ---------------------------------------------------------------------------
// MPX-03 · GUIDANCE THAT CANNOT BE ATTRIBUTED CANNOT BE REPRODUCED
//
// Codex #860 4301851853. `modeFields` tags every field with the stage it came
// from, and says in its own comment that this exists "so a caller can render
// the machine's own grouping rather than one flat list". The guidance surface
// rendered one flat list.
//
// A staged profile deliberately repeats native labels across its components —
// MultiPlex has "Duration" and "Intensity" under both "Slow thermolysis" and
// "Snap" — so the previous treatment showed two values called "Duration" with
// nothing saying which belonged to which component. She cannot reproduce a
// setting she cannot attribute.
//
// AND A SECOND DEFECT in the same line: keying the label map on the field key
// alone let the second stage's label overwrite the first's, so both rows
// could be labelled from the wrong component.
// ---------------------------------------------------------------------------
describe("previous treatment keeps the machine's own stages", () => {

  const stagedReading = (stageKey: string, value: number): RecordedReading =>
    ({
      ...reading({ recordedAt: "2026-10-16T10:00:00Z" }),
      profileId: "fixture:staged",
      profileVersion: 1,
      modeKey: "galvanic",
      stageKey,
      fieldKey: "duration",
      observationSource: null,
      value: { kind: "value", value },
    }) as RecordedReading;

  const html = () =>
    renderToStaticMarkup(
      createElement(MachinePriorSetup, {
        catalogue: [STAGED],
        readings: [stagedReading("slow", 3), stagedReading("snap", 40)],
      }),
    );

  it("names each stage the way the machine does", () => {
    const out = html();
    expect(out).toContain('data-testid="prior-setup-stage-slow"');
    expect(out).toContain('data-testid="prior-setup-stage-snap"');
    expect(out).toMatch(/Slow thermolysis/);
    expect(out).toMatch(/Snap/);
  });

  it("gives the two same-named fields DISTINCT ids", () => {
    // Before this, both rows rendered `prior-setup-g1-duration`. A proof
    // asking for one of them would silently have got whichever came first,
    // and a practitioner had nothing at all to tell them apart.
    const out = html();
    expect(out).toContain('data-testid="prior-setup-g1-slow-duration"');
    expect(out).toContain('data-testid="prior-setup-g1-snap-duration"');
  });

  it("CONTROL: an UNSTAGED profile renders exactly as before", () => {
    // The flat path must be untouched: no stage heading, and the original
    // testid, which the browser proofs already depend on.
    const out = renderToStaticMarkup(
      createElement(MachinePriorSetup, {
        catalogue: CAT,
        readings: [
          { ...reading({ recordedAt: "2026-10-16T10:00:00Z" }), observationSource: null } as RecordedReading,
        ],
      }),
    );
    expect(out).toContain('data-testid="prior-setup-g1-current"');
    expect(out).not.toMatch(/prior-setup-stage-/);
  });
});

const STAGED: MachineProfile = {
  profileId: "fixture:staged",
  version: 1,
  family: "Synthetic/Demo",
  manufacturer: "Fixture",
  model: "Staged",
  availability: "active",
  verification: "device-confirmed",
  frequency: { kind: "not-applicable" },
  evidence: [
    {
      id: "fx",
      kind: "studio-device-photo",
      consultedOn: "2026-10-17",
      establishes: "Nothing about any real machine; it carries two stages that reuse a field key.",
    },
  ],
  openQuestions: [],
  modes: [
    {
      key: "galvanic",
      nativeLabel: "Blend",
      family: "blend",
      availability: "active",
      verification: "device-confirmed",
      evidence: ["fx"],
      fields: [],
      stages: [
        {
          key: "slow",
          nativeLabel: "Slow thermolysis",
          fields: [
            {
              key: "duration",
              nativeLabel: "Duration",
              quantity: "duration",
              unit: "s",
              decimals: 1,
              optional: false,
              expectedSource: "practitioner-entered",
              editable: true,
              verification: "device-confirmed",
              evidence: ["fx"],
            },
          ],
        },
        {
          key: "snap",
          nativeLabel: "Snap",
          fields: [
            {
              // THE SAME KEY under a different stage, which is the whole
              // point of the fixture.
              key: "duration",
              nativeLabel: "Duration",
              quantity: "duration",
              unit: "ms",
              decimals: 0,
              optional: false,
              expectedSource: "practitioner-entered",
              editable: true,
              verification: "device-confirmed",
              evidence: ["fx"],
            },
          ],
        },
      ],
    },
  ],
} as MachineProfile;


// ---------------------------------------------------------------------------
// MPX-03 · THE RECORDED HISTORY KEEPS THE MACHINE'S STAGES TOO
//
// ADDED SCOPE. Codex reported the flattening on the GUIDANCE surface (#860
// 4301851853). This surface had it as well, and it is the one she checks
// before deciding whether a setting has already been recorded — so an
// unattributable row here invites a second immutable capture, which is the
// harm this whole panel exists to prevent.
//
// THE UNSTAGED CONTROL IS THE REAL REGRESSION PROOF: every shipped profile
// today is stageless, so the flat path is the only path in production. It
// must come out exactly as it did before the restructure.
// ---------------------------------------------------------------------------
describe("recorded history keeps the machine's stages", () => {
  const stagedRecorded = (stageKey: string, value: number): RecordedReading =>
    ({
      ...reading({ recordedAt: "2026-10-16T10:00:00Z" }),
      profileId: "fixture:staged",
      profileVersion: 1,
      modeKey: "galvanic",
      stageKey,
      fieldKey: "duration",
      observationSource: null,
      value: { kind: "value", value },
    }) as RecordedReading;

  // NAMED FOR WHAT IT ASSERTS. The first title also claimed it checked
  // distinct SOURCE ids, which it does not: this fixture's readings carry a
  // null observation source, so no source element renders at all. A test
  // whose name overstates its assertions is the same failure as a guard
  // pinning the wrong thing — it reports coverage that is not there.
  it("names each stage the way the machine does", () => {
    const html = renderToStaticMarkup(
      createElement(MachineRecordedSetups, {
        catalogue: [STAGED],
        readings: [stagedRecorded("slow", 3), stagedRecorded("snap", 40)],
      }),
    );
    expect(html).toContain('data-testid="recorded-stage-g1-slow"');
    expect(html).toContain('data-testid="recorded-stage-g1-snap"');
    expect(html).toMatch(/Slow thermolysis/);
    expect(html).toMatch(/Snap/);
  });

  it("CONTROL: an UNSTAGED capture renders exactly as it did before", () => {
    // The whole shipped surface is this path — no active profile has
    // stages. If the restructure changed it at all, that is a regression
    // affecting every studio, in exchange for a case none of them can
    // reach yet.
    const html = renderToStaticMarkup(
      createElement(MachineRecordedSetups, {
        catalogue: CAT,
        readings: [
          { ...reading({ recordedAt: "2026-10-16T10:00:00Z" }), observationSource: null } as RecordedReading,
        ],
      }),
    );
    expect(html).toContain('data-testid="recorded-capture-g1-1"');
    expect(html).not.toMatch(/recorded-stage-/);
    // And the source id keeps its original, unprefixed shape.
    expect(html).not.toMatch(/recorded-source-[a-z]+-/);
  });
});

// ---------------------------------------------------------------------------
// MPX-03 · THE CHANGE SUMMARY NAMES THE COMPONENT, NOT JUST THE FIELD
//
// THE DEFECT (Codex, #860 4308488007). A staged mode repeats native labels
// across its components - MultiPlex carries "Duration" and "Intensity" under
// both "Slow thermolysis" and "Snap" - and the summary printed only the
// FIELD's label. Two genuinely different adjustments therefore rendered as
// two identical rows:
//
//     Duration 3 → 5
//     Duration 40 → 55
//
// On the one surface whose job is to say what changed during the treatment,
// that is a clinical record she cannot attribute. It also collided in the
// testid, so a proof asking for one row silently got whichever came first.
//
// `changesWithin` was ALREADY RIGHT: stageKey is part of the series identity,
// so the two stages were never paired. The pairing was correct and the
// rendering threw the distinction away - which is why these cases assert the
// RENDERED rows rather than the pairing.
// ---------------------------------------------------------------------------
describe("the change summary names which stage moved", () => {
  const stagedChange = (
    stageKey: string,
    revision: number,
    recordedAt: string,
    value: number,
  ): RecordedReading =>
    ({
      ...reading({ recordedAt, revision, captureId: `cap-${stageKey}-${revision}` }),
      profileId: "fixture:staged",
      profileVersion: 1,
      modeKey: "galvanic",
      stageKey,
      fieldKey: "duration",
      observationSource: null,
      value: { kind: "value", value },
    }) as RecordedReading;

  const html = () =>
    renderToStaticMarkup(
      createElement(MachineRecordedSetups, {
        catalogue: [STAGED],
        readings: [
          stagedChange("slow", 1, "2026-10-16T10:00:00Z", 3),
          stagedChange("snap", 1, "2026-10-16T10:00:00Z", 40),
          stagedChange("slow", 2, "2026-10-16T10:20:00Z", 5),
          stagedChange("snap", 2, "2026-10-16T10:20:00Z", 55),
        ],
      }),
    );

  it("renders BOTH changes, with distinct ids", () => {
    // Before the fix both were `recorded-change-g1-duration`.
    const out = html();
    expect(out).toContain('data-testid="recorded-change-g1-slow-duration"');
    expect(out).toContain('data-testid="recorded-change-g1-snap-duration"');
  });

  it("and each row carries the machine's own name for its stage", () => {
    const out = html();
    const row = (id: string) => {
      const from = out.indexOf(`data-testid="${id}"`);
      expect(from, `${id} did not render`).toBeGreaterThan(-1);
      return out.slice(from, out.indexOf("</li>", from));
    };
    expect(row("recorded-change-g1-slow-duration")).toMatch(/Slow thermolysis/);
    expect(row("recorded-change-g1-snap-duration")).toMatch(/Snap/);
  });

  it("so the two rows are not byte-identical, which is the whole defect", () => {
    // THE ASSERTION THAT WOULD HAVE CAUGHT IT. Distinct ids and present
    // labels can both hold while the visible text of the two rows is the
    // same; this compares what she actually reads.
    const out = html();
    const text = (id: string) => {
      const from = out.indexOf(`data-testid="${id}"`);
      return out
        .slice(out.indexOf(">", from) + 1, out.indexOf("</li>", from))
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim();
    };
    const a = text("recorded-change-g1-slow-duration");
    const b = text("recorded-change-g1-snap-duration");
    expect(a.length, "the row rendered empty, so this comparison is vacuous")
      .toBeGreaterThan(5);
    expect(
      a,
      "the two change rows read identically, so she cannot tell which component moved",
    ).not.toBe(b);
  });

  it("falls back to the stage KEY when the version is historical", () => {
    // A SUPERSEDED VERSION has no current labels to offer, and the earlier
    // spelling would then have printed the field key alone for both rows -
    // restoring the collision exactly where the record is oldest. The raw
    // stage key is not pretty, but it distinguishes them.
    //
    // READ FROM THE ROW'S VISIBLE TEXT, not from the document. A negative
    // control is why: asserting `/slow/` against the whole markup passed with
    // the fallback REMOVED, because "slow" is in the testid, which comes from
    // `change.stageKey` and not from the label. The assertion was satisfied
    // by the one thing it was not testing.
    const out = renderToStaticMarkup(
      createElement(MachineRecordedSetups, {
        catalogue: [STAGED],
        readings: [
          { ...stagedChange("slow", 1, "2026-10-16T10:00:00Z", 3), profileVersion: 0 } as RecordedReading,
          { ...stagedChange("slow", 2, "2026-10-16T10:20:00Z", 5), profileVersion: 0 } as RecordedReading,
          { ...stagedChange("snap", 1, "2026-10-16T10:00:00Z", 40), profileVersion: 0 } as RecordedReading,
          { ...stagedChange("snap", 2, "2026-10-16T10:20:00Z", 55), profileVersion: 0 } as RecordedReading,
        ],
      }),
    );
    expect(out).toContain('data-testid="recorded-change-g1-slow-duration"');
    expect(out).toContain('data-testid="recorded-change-g1-snap-duration"');
    const rowText = (id: string) => {
      const from = out.indexOf(`data-testid="${id}"`);
      expect(from, `${id} did not render`).toBeGreaterThan(-1);
      return out
        .slice(out.indexOf(">", from) + 1, out.indexOf("</li>", from))
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim();
    };
    expect(rowText("recorded-change-g1-slow-duration")).toMatch(/\bslow\b/);
    expect(rowText("recorded-change-g1-snap-duration")).toMatch(/\bsnap\b/);
  });

  it("CONTROL: an UNSTAGED change keeps the id and shows no stage at all", () => {
    // Every shipped profile is stageless, so this is the only path in
    // production and it must be untouched - including the testid the browser
    // proofs already depend on.
    const out = renderToStaticMarkup(
      createElement(MachineRecordedSetups, {
        catalogue: CAT,
        readings: [
          reading({ captureId: "c1", revision: 1, recordedAt: "2026-10-14T14:00:00Z", value: 120 }),
          reading({ captureId: "c2", revision: 2, recordedAt: "2026-10-14T14:30:00Z", value: 150 }),
        ],
      }),
    );
    expect(out).toContain('data-testid="recorded-change-g1-current"');
    expect(out).not.toMatch(/recorded-change-g1-[a-z]+-current/);
    expect(out).not.toContain('data-testid="recorded-change-stage"');
  });
});


// ---------------------------------------------------------------------------
// NO MACHINE SURFACE FORMATS AN INSTANT ITSELF (Codex, #860 4309128374)
//
// WHY THIS IS THE LOAD-BEARING GUARD, and the markup assertions above are not.
// A negative control proved it: restoring `toLocaleDateString(undefined, …)`
// and `toLocaleTimeString(undefined, …)` left every rendered-markup assertion
// GREEN, because `FormattedDateTime` renders nothing server-side WHATEVER it
// is handed - so a locally formatted string passed to it as `iso` produces
// exactly the same empty server output as the correct code. The absence of a
// day in the markup therefore cannot distinguish the fix from the defect.
//
// What can is the source: the component must not format an instant at all.
// A tree walk rather than a list of two files, because a third machine
// surface that renders a timestamp would not be on the list.
//
// THE ONE ALLOWED PLACE is `components/formatted-date-time.tsx`, which
// formats inside `useEffect` - so it only ever runs in the browser, where
// there is exactly one locale and one timezone. That file is outside this
// walk.
//
// OUT OF SCOPE, REPORTED NOT FIXED: `components/clinical-notes-summary.tsx`
// uses the same `toLocaleDateString(undefined, …)` shape. It belongs to
// another feature and was not part of this finding, so it is named for
// whoever owns it rather than changed here.
// ---------------------------------------------------------------------------
describe("no machine component formats an instant itself", () => {
  const LANE = "components/machines";

  const walk = (rel: string): string[] => {
    const abs = nodePath.resolve(__dirname, "../..", rel);
    const out: string[] = [];
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const next = `${rel}/${e.name}`;
      if (e.isDirectory()) out.push(...walk(next));
      else if (/\.tsx?$/.test(e.name)) out.push(next);
    }
    return out;
  };

  // LINE comments before BLOCK comments: both components discuss the defect by
  // name at length, so a guard reading raw text is tripped by the explanation.
  const code = (rel: string) =>
    readFileSync(nodePath.resolve(__dirname, "../..", rel), "utf8")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

  const BANNED = /toLocale(Date|Time)?String\s*\(/;

  it("ANTI-VACUITY: the walk finds files and the matcher sees the banned form", () => {
    const files = walk(LANE);
    expect(files.length, "the machine component tree walked to nothing").toBeGreaterThan(3);
    expect(BANNED.test('d.toLocaleDateString(undefined, {})')).toBe(true);
    expect(BANNED.test('d.toLocaleTimeString(undefined, {})')).toBe(true);
    // And a comment ABOUT it is not a call, which is what the stripping is for.
    expect(BANNED.test(code("components/machines/machine-prior-setup.tsx"))).toBe(
      false,
    );
  });

  it("not one of them calls toLocale*String", () => {
    const offenders = walk(LANE).filter((rel) => BANNED.test(code(rel)));
    expect(
      offenders,
      "a machine surface formats an instant with the runtime's own locale and timezone, which renders differently in Node and in the browser - and near midnight a different DAY",
    ).toEqual([]);
  });

  it("and the two that show a timestamp route it through FormattedDateTime", () => {
    // The positive half: banning the call is satisfied by showing nothing at
    // all, so the renderer has to be named too.
    for (const rel of [
      "components/machines/machine-prior-setup.tsx",
      "components/machines/machine-recorded-setups.tsx",
    ]) {
      expect(code(rel), `${rel} no longer renders instants at all`).toMatch(
        /<FormattedDateTime\s/,
      );
      expect(code(rel)).toMatch(
        /from "@\/components\/formatted-date-time"/,
      );
    }
  });
});
