"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { MachineFirstSetupPanel } from "./machine-first-setup-panel";
import { NO_PERSISTENCE } from "@/lib/machines/selection-store";
import type { MachineSetupContext } from "@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions";

// MPX-03 — the panel with its identity resolved on the server, ON DEMAND.
//
// WHY THIS LOADS ON A CLICK AND NOT ON MOUNT. The first version fired
// `loadMachineSetupContext()` from a `useEffect`, and two existing browser
// specs caught what that costs:
//
//   * e2e/repeat-client-fast-charting.spec.ts records EVERY server-action POST
//     to the session route and classifies any without an `idempotencyKey` as a
//     "source read", because its whole purpose is to prove that a retried
//     commit does not re-read the source. An on-mount context load is exactly
//     such a POST, so it polluted the sequence that test exists to protect.
//   * e2e/conditional-numbing-notes.spec.ts lost its save: an extra
//     server-action round trip racing the form's own commit on the same route.
//
// Both were real. Adding a silent round trip to a clinical form every time a
// practitioner opens a settings block is a regression whether or not a test
// notices, and the cheapest correct answer is not to make the request until
// she asks for the machine panel. Machine-first is preserved as an explicit
// step she takes BEFORE entering settings, which is if anything clearer than a
// panel that quietly populates itself.
//
// WHAT IT STILL DOES NOT DO. It sends no studio id and no practitioner id:
// those are ACTOR facts and the server derives them from the authenticated
// session on every call.
//
// It DOES send the route's client and session ids, and that is not a loophole
// in the sentence above. Which chart is open is a subject, not an authority
// claim, and the server authorizes the pair with `assertSessionForClient`
// before reading anything. Sending nothing at all was the actual bug: with no
// client in scope the prior-setup read fell back to the whole studio and could
// show another client's settings (Codex, 9c6fbbe5).

/** ONE refusal text for clearing a saved machine, wherever it is reached (Insurance N-3). */
export const RECORD_UNAVAILABLE_AFTER_SAVE_NOTICE =
  "Saved. This treatment record could not be loaded just now; reload to try again.";
export const ACCESS_REFUSED_AFTER_SAVE_NOTICE =
  "Saved. You no longer have access to this treatment record, so its readings are not shown.";
export const SAVED_REFRESH_FAILED_NOTE = "Saved. The latest readings couldn't be refreshed; reload to see them.";
export const PREFERENCE_NOT_REMEMBERED = "That machine was not remembered for your next visit.";
export const SAVED_MACHINE_CANNOT_BE_CLEARED =
  "Choose another machine to change this one. A saved machine cannot be cleared.";

/** ONE refusal text for a native machine on an area that already holds xCell Pur readings (Codex, #1369 4471593271). */
export const LEGACY_AREA_NATIVE_MACHINE_REFUSED =
  "This area already has xCell Pur readings. Add a new area to chart another machine.";

export type MachineFirstSetupConnectedProps = {
  /** The treatment block being charted, from the host form. */
  blockId?: string | null;
  /**
   * Route values from the host form, authorized on the server. Required for a
   * correct prior-setup read: without them it is not possible to ask "what did
   * THIS client last have", only the wrong question.
   */
  clientId: string;
  sessionId: string;
  /** The block version the host form holds, sent with a saved-area identity write. */
  blockVersion?: string | null;
  /** Called with the block's new version after THIS panel's own identity write. */
  onBlockVersion?: (updatedAt: string) => void;
  /**
   * The saved area already holds xCell Pur readings (the host's own test). A native machine is refused BEFORE the selector
   * moves or anything is written; the database refuses it too (0301). The legacy machine itself stays choosable.
   */
  legacyReadingsLocked?: boolean;
  /** Injected by tests; production uses the server action. */
  load?: () => Promise<MachineSetupContext>;
  /** Injected by tests; production uses the server action. */
  record?: MachineFirstSetupPanelRecord;
  /**
   * Collect settings in CREATE mode and hand them to the host form's save.
   *
   * Passed straight through to the panel. The host supplies it only when it
   * can actually carry them into its own Save - `block-setup-form.tsx` does,
   * through `initialSetup`.
   */
  /** Forwarded to the panel: the host's save is unresolved. */
  settingDraftFrozen?: boolean;
  /** Forwarded straight through: see the panel's own prop. */
  onRevisionUnresolved?: (unresolved: boolean) => void;
  onRevisionDraft?: (hasDraft: boolean) => void;
  /**
   * True while a SAVED area's machine choice is being written (Codex, #1369 4477716784). The host holds its
   * own Save for that long: if the block save committed first, the identity write would be refused as stale
   * and the machine choice lost without a word.
   */
  onIdentityWritePending?: (pending: boolean) => void;
  /**
   * The practitioner already typed charting values on this NEW area. The panel then selects nothing by itself (no client-last,
   * remembered or restored machine), because a native pick clears those values (Codex, #1369 4479490063).
   */
  holdAutoSelect?: boolean;
  onSettingDraft?: NonNullable<
    Parameters<typeof MachineFirstSetupPanel>[0]["onSettingDraft"]
  >;
  /** Injected by tests; production uses the server action. */
  select?: (choice: {
    deviceId: string | null;
    modeKey: string | null;
    legacy?: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  /**
   * The machine SAVED on this treatment area (migration 0301), read from the
   * block row the page already loaded. It is the record, and it wins over the
   * remembered preference and over a suggestion. When present, the panel opens
   * on it at once instead of waiting for a click, so a reopened area shows its
   * machine rather than an empty "Choose machine".
   */
  savedIdentity?: {
    profileId: string | null;
    deviceId: string | null;
    modeKey: string | null;
  } | null;
  /** Forwarded to the panel: which kind of machine is in force. */
  onKindChange?: NonNullable<
    Parameters<typeof MachineFirstSetupPanel>[0]["onKindChange"]
  >;
  /**
   * CREATE MODE: the choice, handed to the host form so its Save writes the
   * area and the choice in one transaction. Null when nothing is chosen.
   */
  onIdentityDraft?: (
    choice: { deviceId: string | null; modeKey: string | null; profileId: string | null } | null,
    /** True for a pick the practitioner made; false for one the panel resolved. */
    explicit: boolean,
  ) => void;
};

type MachineFirstSetupPanelRecord = NonNullable<
  Parameters<typeof MachineFirstSetupPanel>[0]["onRecord"]
>;

type IdentityChoice = { deviceId: string | null; modeKey: string | null; profileId: string | null };
type IdentityWriteOutcome =
  | { ok: true; updatedAt?: string; reused?: boolean; identity?: IdentityChoice }
  | { ok: false; code: string; error: string };
/** Same-key replays after an unconfirmed identity write, before the pick is reported as unconfirmed. */
export const IDENTITY_REPLAYS = 2;
export const IDENTITY_REPLAY_DELAY_MS = 300;
const IDENTITY_SETTLED_DIFFERENTLY =
  "That choice was already settled as a different machine. The machine shown is the one that is saved.";
const IDENTITY_UNCONFIRMED =
  "We could not confirm that your machine choice was saved. The machine shown is the last one confirmed. Choose it again to settle it, or reload the page to see what is saved.";

/**
 * One recorder result, relayed to the entry.
 *
 * EXPORTED AND PURE so the chain can be driven by a test. It was an inline
 * ternary inside the component's `onRecord` closure, which nothing could
 * call — this repository has no jsdom — so the only evidence that the
 * outcome code survived this hop was a source scan. It did not survive it
 * (Codex, #860 4301771498), and the scan said it did.
 *
 * THE WHOLE JOB IS NOT LOSING ANYTHING. That sounds too small to name until
 * you count: five values in this lane have been computed correctly and
 * dropped at a hop exactly like this one.
 */
export function relayRecordResult(out: {
  ok: boolean;
  code?: string;
  error?: string;
  captures?: number;
  written?: number;
  reused?: boolean;
}): {
  ok: boolean;
  code?: string;
  error?: string;
  captures?: number;
  written?: number;
  reused?: boolean;
} {
  return out.ok
    ? {
        ok: true,
        captures: out.captures,
        written: out.written,
        reused: out.reused,
      }
    : { ok: false, code: out.code, error: out.error };
}

export function MachineFirstSetupConnected({
  blockId = null,
  clientId,
  sessionId,
  load,
  select,
  record,
  onSettingDraft,
  settingDraftFrozen = false,
  onRevisionUnresolved,
  onRevisionDraft,
  onIdentityWritePending,
  holdAutoSelect = false,
  savedIdentity: savedIdentityProp = null,
  onKindChange,
  onIdentityDraft,
  blockVersion,
  onBlockVersion,
  legacyReadingsLocked = false,
}: MachineFirstSetupConnectedProps) {
  // WHAT THIS AREA HAS PERSISTED, tracked from this panel's own successful
  // identity writes (Codex, #1369 4475581937). The prop is the identity the page
  // loaded; an area that started with none and then recorded one here kept
  // reporting "none", so a later clear took the preference-only branch, said it
  // had worked, and left the saved identity in place.
  // THE PICK WHOSE ANSWER IS NOT KNOWN: its key and what it asked for, kept until a same-key retry settles it.
  const identityAttemptRef = useRef<{ sig: string; key: string; choice: IdentityChoice } | null>(null);
  const [written, setWritten] = useState<NonNullable<MachineFirstSetupConnectedProps["savedIdentity"]> | null>(null);
  const savedIdentity = written ?? savedIdentityProp;
  const [ctx, setCtx] = useState<MachineSetupContext | null>(null);
  // A CONFIRMED SAVE whose follow-up refresh of the recorded settings failed: the save stands, only the list is out of date.
  const [refreshFailedAfterSave, setRefreshFailedAfterSave] = useState(false);
  const [refusedAfterSave, setRefusedAfterSave] = useState<"access" | "unavailable" | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");

  const open = useCallback(async () => {
    setState("loading");
    try {
      const loader =
        load ??
        (async () => {
          const mod = await import(
            "@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions"
          );
          return mod.loadMachineSetupContext({ clientId, sessionId, blockId });
        });
      setCtx(await loader());
      setState("idle");
    } catch {
      // Charting below is unaffected by a failed identity read, so this is
      // reported in place rather than escalated.
      setState("failed");
    }
  }, [load, clientId, sessionId, blockId]);

  // A SAVED CHOICE OPENS THE PANEL AT ONCE. Only an area that already carries
  // an identity does this, so the on-mount server action stays out of every
  // other charting path (the reason the load waits for a click elsewhere).
  const hasSavedIdentity = Boolean(
    savedIdentity && (savedIdentity.deviceId || savedIdentity.profileId),
  );
  // THE HOLDS THE ENTRY REPORTED TO THE HOST ARE RELEASED ON EVERY CLOSE PATH (Codex #1369 4488223260, Sam's overnight direction). A refused
  // refresh releases them inline (below); this cleanup covers every other way the panel goes: the host closing the form, a re-render that
  // swaps the wrapper out, the effect's own dependency changing. Reported through a ref so the LATEST callbacks are used, and kept in the
  // wrapper's ONE existing effect (a guard pins exactly one).
  const holdsRef = useRef({ onRevisionUnresolved, onRevisionDraft });
  holdsRef.current = { onRevisionUnresolved, onRevisionDraft };
  useEffect(() => {
    if (hasSavedIdentity && state === "idle" && ctx === null) void open();
    return () => {
      holdsRef.current.onRevisionUnresolved?.(false);
      holdsRef.current.onRevisionDraft?.(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSavedIdentity]);

  if (!ctx) {
    return (
      <section
        className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900"
        data-testid="machine-first-trigger"
      >
        <SectionLabel as="h3" className="!text-neutral-700 dark:!text-neutral-300">
          Machine
        </SectionLabel>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Record which machine you are working on before entering its settings.
        </p>
        {/*
          THE SHARED PRIMITIVE, for the third time in this lane and the same
          reason each time. This was `text-xs py-1.5` with no minimum height -
          about 30px on a touch device, under DESIGN.md LAW 6's 44px floor -
          and it is the ONLY way into machine selection, so the one control a
          practitioner must hit on a phone was the one below the floor
          (Codex, #860 4296029615).
          Button's `sm` composes CONTROL_COMPACT_FINE_POINTER: the full 44px on
          every coarse pointer, relaxing to 32px only behind the repository's
          explicit `pointer-fine` gate. The mode pills were repaired this way
          after ebc69ff6 and the lesson is unchanged - the rule belongs in the
          primitive, because a call site can forget it, and call sites do.
        */}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="self-start"
          onClick={open}
          disabled={state === "loading" || settingDraftFrozen}
          data-testid="machine-first-open"
        >
          {state === "loading" ? "Loading…" : "Choose machine"}
        </Button>
        {state === "failed" && (
          <p className="text-xs text-neutral-600 dark:text-neutral-400" role="status">
            Your machines could not be loaded. The treatment fields below are
            unaffected and still save normally.
          </p>
        )}
      </section>
    );
  }

  const onRecord: MachineFirstSetupPanelRecord =
    record ??
    (async (input) => {
      const mod = await import(
        "@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions"
      );
      // THE WHOLE-SAVE COMMAND, not one call per group. The per-group action
      // is still exported and still correct for a single group recorded on its
      // own - that is why a capture made through it carries no submission id -
      // but the treatment form saves every group the practitioner entered, and
      // that has to be one atomic fact with one retry key.
      // THE ROUTE'S OWN IDS, added here rather than taken from the panel.
      // The panel knows which block it is charting; it does NOT get to say
      // whose chart that is. These come from this wrapper's props, which the
      // page supplied, and the server re-checks them against the studio it
      // derives for itself (Codex, #860 4297032712).
      setRefreshFailedAfterSave(false);
      setRefusedAfterSave(null);
      const out = await mod.recordSetupSubmissionAction({
        ...input,
        clientId,
        sessionId,
        expectedUpdatedAt: blockVersion ?? null,
      });
      if (out.ok && out.updatedAt) onBlockVersion?.(out.updatedAt);
      // WHAT IS RECORDED HAS CHANGED, SO RE-READ IT.
      //
      // `recordedSetup` was loaded once when this panel opened and never
      // refreshed, which cost two things (Codex, #860 4300386011):
      //
      //   1. THE SEED. The entry form restores its group identities from
      //      this snapshot on every mount. Save g1 and g2, switch machine
      //      or mode, switch back — the remount seeds from a snapshot that
      //      predates those captures, finds nothing, and falls back to a
      //      fresh g1. A change meant for g2 is then recorded as a g1
      //      revision: the identity defect again, on the save-then-switch-
      //      back path.
      //   2. THE SURFACE BELOW IT. "Recorded this treatment" also renders
      //      from this snapshot, so a capture she had just made was absent
      //      from the list that exists to stop her recording it twice.
      //
      // Both are the same staleness, so both are fixed by re-reading the
      // truth rather than by patching the seed. The SERVER is asked, not a
      // local tally: a client-side map of "what I just saved" would be a
      // second account of the record that can disagree with it, and an
      // absorbed retry (`reused`) writes nothing while still meaning those
      // groups exist.
      if (out.ok) {
        // A FAILED REFRESH KEEPS THE OLD SNAPSHOT AND SAYS SO.
        //
        // The first version of this installed whatever came back and
        // wrapped the call in a `catch`. The catch could not fire —
        // `readingsForBlockAction` returned `[]` on failure rather than
        // throwing — so a transient read failure REPLACED the history with
        // an empty list while `recordedSetupUnavailable` stayed false. The
        // list she relies on to avoid recording twice simply vanished,
        // right after a save (Codex, #860 4300759932).
        //
        // That is round 4's conflation one layer down: I fixed "a failed
        // read must not render as nothing recorded" in the component and
        // then rebuilt it in the data path feeding that component. The
        // action now reports failure explicitly, and this keeps the
        // PREVIOUS readings — which are still true, just one capture out of
        // date — and marks the surface unavailable so the copy says it
        // could not be refreshed.
        //
        // The save itself is untouched either way: it already committed,
        // and reporting it as failed here would manufacture the
        // lost-response defect.
        let fresh: Awaited<ReturnType<typeof mod.readingsForBlockAction>>;
        try {
          fresh = await mod.readingsForBlockAction({
            blockId: input.blockId,
            clientId,
            sessionId,
          });
        } catch {
          fresh = { ok: false };
        }
        setCtx((prev) =>
          prev
            ? fresh.ok
              ? {
                  ...prev,
                  recordedSetup: fresh.readings,
                  recordedSetupUnavailable: false,
                  // THE NAMES COME WITH THEM (Codex, #860 4301669061).
                  //
                  // Refreshing the captures and leaving the name map at its
                  // pre-save snapshot left a capture saved on a unit the
                  // loader had not already seen with NO physical machine
                  // against it until a reload - and in a studio running two
                  // units of one model, that attribution is the entry's
                  // whole purpose.
                  //
                  // MERGED, NOT REPLACED, and that is not a detail: the
                  // refresh re-reads only this BLOCK, while the loader's map
                  // also names the next-visit guidance and an unusable
                  // stored selection. Assigning `fresh.unitNames` would name
                  // the new capture and silently un-name the prior setup
                  // beside it - fixing one surface by breaking its
                  // neighbour, which is how two of this lane's earlier
                  // repairs went.
                  unitNames: { ...prev.unitNames, ...fresh.unitNames },
                }
              : prev
            : prev,
        );
        // A CONFIRMED SAVE KEEPS ITS "SAVED" (OPS decision after #1369 shard 1 at 6dc30fdd3). The refresh runs only after the
        // save was confirmed, so a failed refresh used to replace the whole entry, the saved confirmation included, with "could not
        // be read just now", which is the notice for a failure when the panel OPENS and still is. Here the snapshot is kept
        // (still true, one capture out of date) and a plain note says so. Nothing is re-sent: the entry stays on its saved view.
        // FAIL CLOSED FOR ACCESS, GENTLE ONLY FOR A TRANSIENT ERROR (#1369 R3-2). A definitive refusal (not signed in, or the record is no
        // longer this practitioner's) must not leave the old readings on screen, so the entry is replaced by the access notice.
        // REPORT THE HOLDS CLEARED BEFORE THE PANEL IS REMOVED (Codex #1369 4488223260). The entry reported a revision awaiting its retry and an
        // unsaved draft to the host, and nothing reports them released when a refused refresh replaces the panel with a notice: "Save
        // settings block" and Cancel stayed disabled for ever. The save was confirmed, so neither hold is true any more. (No effect is used
        // here on purpose: this wrapper keeps exactly one, for opening a saved machine.)
        if (!fresh.ok && fresh.refused) {
          onRevisionUnresolved?.(false);
          onRevisionDraft?.(false);
        }
        setRefusedAfterSave(!fresh.ok ? (fresh.refused ?? null) : null);
        setRefreshFailedAfterSave(!fresh.ok && !fresh.refused);
      }
      return relayRecordResult(out);
    });

  // The selection action the panel calls on every pick and on "Change
  // machine". Previously absent, which is why a choice never survived a
  // reload even though the store and the action were both correct.
  const selectMachineInner = async (choice: {
    deviceId: string | null;
    modeKey: string | null;
    legacy?: boolean;
  }) => {
    // A SAVED IDENTITY IS CHANGED TO ANOTHER MACHINE, NOT CLEARED: there is no
    // command that clears one. Refused up front and consistently, before the
    // preference is touched, so nothing reports success for a clear that did not
    // happen.
    if (
      blockId &&
      choice.deviceId === null &&
      !choice.legacy &&
      savedIdentity &&
      (savedIdentity.deviceId || savedIdentity.profileId)
    ) {
      return { ok: false, error: SAVED_MACHINE_CANNOT_BE_CLEARED, reverted: true };
    }
    // A SAVED AREA WITH xCell Pur READINGS TAKES NO NATIVE MACHINE: refused here, before the preference or the record is
    // touched (the panel does not move on a reverted refusal), and again by the database.
    if (blockId && legacyReadingsLocked && !choice.legacy && choice.deviceId !== null) {
      return { ok: false, error: LEGACY_AREA_NATIVE_MACHINE_REFUSED, reverted: true };
    }
    const mod = await import(
      "@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions"
    );
    const legacyProfile = choice.legacy ? (ctx.legacyMachine?.profileId ?? null) : null;
    const chosen =
      choice.deviceId !== null || legacyProfile !== null
        ? { deviceId: choice.deviceId, modeKey: choice.modeKey, profileId: legacyProfile }
        : null;
    // THE RECORD FIRST, FOR A SAVED AREA (Insurance LK-3): this area's own machine is written now, and a refusal (the database
    // refuses a native machine on an area with xCell Pur readings the page did not know about, or a stale tab) must leave the
    // remembered preference where it was, not move it to a machine this area cannot take. A new area carries the choice into
    // the host's Save instead (one transaction).
    if (blockId && chosen !== null) {
      // A WRITE WHOSE ANSWER WAS LOST IS SETTLED BY ITS KEY, NOT REPORTED AS REVERTED (Codex 4488743493). Each pick has ONE key,
      // reused by every retry of it; the database answers a same-key retry from its receipt with the version THAT write produced
      // and the identity it recorded (never the block's current version: a colleague's later edit must still conflict, N-8).
      let version = blockVersion ?? null;
      // WHAT THIS CALL HAS ADOPTED: the machine the database now holds because of a write settled here. Any refusal that follows it must
      // hand it to the panel as the fallback, or the panel keeps showing the machine from BEFORE the call (Codex #1369 4493827101).
      let adopted: IdentityChoice | null = null;
      const revertedTo = (error: string) => ({
        ok: false as const,
        error,
        reverted: true as const,
        ...(adopted
          ? {
              fallback: {
                deviceId: adopted.deviceId,
                modeKey: adopted.modeKey,
                legacy: adopted.deviceId === null && adopted.profileId !== null,
              },
            }
          : {}),
      });
      const adopt = (out: Extract<IdentityWriteOutcome, { ok: true }>, fallback: IdentityChoice) => {
        const stored = out.identity ?? fallback;
        setWritten({ profileId: stored.profileId, deviceId: stored.deviceId, modeKey: stored.modeKey });
        adopted = { profileId: stored.profileId, deviceId: stored.deviceId, modeKey: stored.modeKey };
        if (out.updatedAt) {
          version = out.updatedAt;
          onBlockVersion?.(out.updatedAt);
        }
        identityAttemptRef.current = null;
      };
      const write = async (c: IdentityChoice, key: string): Promise<IdentityWriteOutcome> => {
        for (let attempt = 0; ; attempt += 1) {
          let out: IdentityWriteOutcome;
          try {
            out = await mod.recordBlockMachineIdentityAction({
              clientId,
              sessionId,
              blockId,
              deviceId: c.deviceId,
              modeKey: c.modeKey,
              profileId: c.profileId,
              expectedUpdatedAt: version,
              idempotencyKey: key,
            });
          } catch {
            out = { ok: false, code: "unknown", error: IDENTITY_UNCONFIRMED };
          }
          if (out.ok || out.code !== "unknown" || attempt >= IDENTITY_REPLAYS) return out;
          await new Promise((resolve) => setTimeout(resolve, IDENTITY_REPLAY_DELAY_MS));
        }
      };
      const sig = `${chosen.deviceId ?? ""}|${chosen.modeKey ?? ""}|${chosen.profileId ?? ""}`;
      const earlier = identityAttemptRef.current;
      // A DIFFERENT PICK WHILE AN EARLIER ONE IS UNCONFIRMED: settle the earlier one first, so this pick is written against the
      // version that write produced (or not at all), never against a version the earlier write has already moved.
      if (earlier && earlier.sig !== sig) {
        const settled = await write(earlier.choice, earlier.key);
        if (settled.ok) adopt(settled, earlier.choice);
        else if (settled.code === "unknown") return revertedTo(IDENTITY_UNCONFIRMED);
        else identityAttemptRef.current = null;
      }
      const attempt = identityAttemptRef.current ?? { sig, key: globalThis.crypto.randomUUID(), choice: chosen };
      const saved = await write(chosen, attempt.key);
      if (!saved.ok) {
        // Unconfirmed: keep the key, so asking again is answered from the receipt (or writes once). Definitive: nothing was written.
        identityAttemptRef.current = saved.code === "unknown" ? attempt : null;
        return revertedTo(saved.code === "unknown" ? IDENTITY_UNCONFIRMED : saved.error);
      }
      adopt(saved, chosen);
      // THE ANSWER IS FOR A DIFFERENT MACHINE THAN WAS ASKED (a replay answered from another pick's receipt): the panel must show what
      // the database holds, not what was clicked.
      const got = adopted as IdentityChoice | null;
      if (got && `${got.deviceId ?? ""}|${got.modeKey ?? ""}|${got.profileId ?? ""}` !== sig) {
        return revertedTo(IDENTITY_SETTLED_DIFFERENTLY);
      }
    }
    // THE PREFERENCE (a suggestion for the next visit) is written only for a
    // native unit; choosing the existing workflow leaves it alone.
    let pref: { ok: boolean; error?: string } = { ok: true };
    if (!choice.legacy) {
      // A THROW IS NOT A REVERT (Codex 4487384231). For a saved area the record was committed above; a preference request that
      // throws (a transport error) says nothing about it, so the committed choice stays and only a quiet note is shown.
      try {
        const out =
          choice.deviceId === null
            ? await mod.clearMachineSelectionAction()
            : await mod.rememberMachineSelectionAction({
                deviceId: choice.deviceId,
                modeKey: choice.modeKey,
              });
        pref = out.ok ? { ok: true } : { ok: false, error: out.error };
      } catch {
        pref = { ok: false, error: PREFERENCE_NOT_REMEMBERED };
      }
    }
    if (!blockId) {
      onIdentityDraft?.(chosen, true);
      return pref;
    }
    if (chosen === null) {
      return savedIdentity && (savedIdentity.deviceId || savedIdentity.profileId)
        ? { ok: false, error: SAVED_MACHINE_CANNOT_BE_CLEARED, reverted: true }
        : pref;
    }
    return pref;
  };

  // A SAVED AREA'S PICK IS A WRITE AGAINST THE BLOCK'S VERSION: hold the host's Save for its whole duration,
  // including the preference write before it. A new area writes nothing here (its pick rides the host's Save).
  const onSelectMachine = async (choice: { deviceId: string | null; modeKey: string | null; legacy?: boolean }) => {
    if (!blockId) return selectMachineInner(choice);
    onIdentityWritePending?.(true);
    try {
      return await selectMachineInner(choice);
    } finally {
      onIdentityWritePending?.(false);
    }
  };

  // A NEW AREA STARTS ON THIS CLIENT's LAST MACHINE when there is one (Photos R2): the previous machine is
  // the client's, not the practitioner's last pick anywhere. The remembered preference is the fallback, and
  // an area that already has a saved identity is never touched.
  const hasSaved = Boolean(savedIdentity && (savedIdentity.deviceId || savedIdentity.profileId));
  // NEW AREAS ONLY (Insurance N-7): an existing identity-less area (pre-0301 data) opens exactly as before.
  const hold = holdAutoSelect && !blockId;
  const newAreaLast = !hasSaved && !blockId && !hold ? (ctx.clientLastMachine ?? null) : null;
  const autoRemembered = hold ? null : (ctx.remembered ?? null);

  if (refusedAfterSave) {
    return (
      <p className="text-sm text-amber-800" role="alert" data-testid={refusedAfterSave === "access" ? "machine-access-refused" : "machine-record-unavailable"}>
        {refusedAfterSave === "access" ? ACCESS_REFUSED_AFTER_SAVE_NOTICE : RECORD_UNAVAILABLE_AFTER_SAVE_NOTICE}
      </p>
    );
  }

  return (
    <>
    <MachineFirstSetupPanel
      scope={ctx.scope}
      devices={ctx.devices}
      initialDeviceId={newAreaLast ? newAreaLast.deviceId : (autoRemembered?.deviceId ?? null)}
      // The remembered MODE, which the loader has always resolved and which
      // nothing forwarded - so the panel silently used each profile's first
      // active mode and recorded against the wrong field contract.
      initialModeKey={newAreaLast ? newAreaLast.modeKey : (autoRemembered?.modeKey ?? null)}
      // The server resolved the stored selection; when it is not usable the
      // panel shows nothing chosen and states the reason, rather than an
      // empty picker beside a claim that a machine is remembered.
      // A valid client-last machine WINS over an unavailable remembered preference (Codex, #1369 4478497436):
      // the stale preference is only stated when nothing better was chosen for this new area.
      unavailableSelection={newAreaLast ? null : ctx.rememberedUnavailable}
      // The unit this client's last setup used, offered (not selected) when
      // nothing is remembered. Forwarded here or it is inert in the real route.
      suggestedMachine={ctx.suggestedMachine}
      // A reopened visit's last saved unit and mode. Forwarded here or it is
      // inert in the real route.
      restoredSelection={
        savedIdentity?.deviceId && savedIdentity.modeKey
          ? { deviceId: savedIdentity.deviceId, modeKey: savedIdentity.modeKey }
          : hold
            ? null
            : ctx.restoredSelection
      }
      // The existing workflow as a choice in THE selector, and whether this
      // area was saved as it.
      legacyMachine={ctx.legacyMachine}
      nativeLocked={Boolean(blockId) && legacyReadingsLocked}
      // THE SAVED UNIT, from the area's own record (Insurance W-1): not from the panel's current pick, which can be a remembered
      // preference on an area that never saved an identity.
      savedDeviceId={blockId ? (savedIdentity?.deviceId ?? null) : null}
      initialLegacyChosen={
        (savedIdentity?.deviceId == null && savedIdentity?.profileId != null) ||
        Boolean(newAreaLast?.legacy)
      }
      onKindChange={onKindChange}
      // A machine the panel resolves on its own is carried too (create mode),
      // so what is shown is what Save records. Not marked as an edit.
      onResolvedChoice={
        blockId || !onIdentityDraft
          ? undefined
          : (c) =>
              onIdentityDraft(
                c
                  ? {
                      deviceId: c.deviceId,
                      modeKey: c.modeKey,
                      profileId: c.legacy ? (ctx.legacyMachine?.profileId ?? null) : null,
                    }
                  : null,
                false,
              )
      }
      inventoryReason={ctx.inventoryReason}
      persistence={ctx.persistence ?? NO_PERSISTENCE}
      // The catalogue is whatever the SERVER resolved, so the synthetic demo
      // profile reaches the client only when the server's gate allowed it.
      catalogue={ctx.catalogue.length > 0 ? ctx.catalogue : undefined}
      canManageMachines={ctx.canManageMachines}
      priorSetup={ctx.priorSetup}
      // The names for those recorded units. Resolved on the server, because
      // only the server can see a RETIRED unit. Omitting this left the panel
      // with its default empty map in the real route, so the whole lookup was
      // inert in production while the direct-render tests passed - they supply
      // the prop themselves and so cannot see a wiring gap
      // (Codex, 2351742d).
      unitNames={ctx.unitNames}
      // WHAT IS ALREADY RECORDED against this block. Forwarded here, which is
      // the step that was missing for `priorUnitNames` and the remembered
      // mode: both existed in the loader, the props and the panel's own
      // forwarding, and died HERE, so the feature was inert in production
      // while every direct-render test passed (Codex, 2351742d and 15cc6c99).
      // The context-forwarding guard in
      // tests/components/machine-first-setup-panel.test.ts derives the field
      // list from MachineSetupContext's own declaration, so this line is not
      // optional - omitting it fails that test.
      recordedSetup={ctx.recordedSetup}
      // AND ITS FAILURE STATE, which is a separate field precisely so it
      // cannot be inferred from an empty list. The guard above caught this
      // line missing the moment the field joined MachineSetupContext - a
      // third instance of the defect its comment describes, found by the test
      // rather than in review (Codex, #860 4290452722).
      // THE GUARD CAUGHT THIS ONE TOO. `priorSetupUnavailable` joined
      // MachineSetupContext and was not forwarded — the fourth time the
      // context-forwarding test has found a field that existed in the
      // loader, the type and the panel's props and died on this line,
      // leaving the feature inert in the real route while every
      // direct-render test passed (Codex, 2351742d, 15cc6c99, #860
      // 4290452722).
      priorSetupUnavailable={ctx.priorSetupUnavailable}
      recordedSetupUnavailable={ctx.recordedSetupUnavailable}
      submissionBlocked={refreshFailedAfterSave}
      blockId={blockId}
      // CREATE MODE. Forwarded rather than recreated here, and the
      // context-forwarding guard cannot see this one because it is not a
      // context field - so it is pinned by its own source assertion in
      // tests/components/machine-first-setup-panel.test.ts.
      onSettingDraft={onSettingDraft}
      // FORWARDED. Five values in this lane have been computed correctly and
      // dropped at a hop exactly like this one.
      onRevisionUnresolved={onRevisionUnresolved}
      onRevisionDraft={onRevisionDraft}
      settingDraftFrozen={settingDraftFrozen}
      onSelectMachine={select ?? onSelectMachine}
      onRecord={onRecord}
    />
    {refreshFailedAfterSave ? (
      <p className="text-sm text-amber-800" role="status" data-testid="machine-saved-refresh-note">
        {SAVED_REFRESH_FAILED_NOTE}
      </p>
    ) : null}
    </>
  );
}
