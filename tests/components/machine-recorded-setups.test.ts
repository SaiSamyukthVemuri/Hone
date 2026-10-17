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
    expect(html).toMatch(/\d{1,2}:\d{2}/);
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
    expect(html).toMatch(/\d{1,2}:\d{2}/);
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
