"use client";

import { useCallback, useEffect, useState } from "react";

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
export const SAVED_MACHINE_CANNOT_BE_CLEARED =
  "Choose another machine to change this one. A saved machine cannot be cleared.";

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
  savedIdentity: savedIdentityProp = null,
  onKindChange,
  onIdentityDraft,
  blockVersion,
  onBlockVersion,
}: MachineFirstSetupConnectedProps) {
  // WHAT THIS AREA HAS PERSISTED, tracked from this panel's own successful
  // identity writes (Codex, #1369 4475581937). The prop is the identity the page
  // loaded; an area that started with none and then recorded one here kept
  // reporting "none", so a later clear took the preference-only branch, said it
  // had worked, and left the saved identity in place.
  const [written, setWritten] = useState<NonNullable<MachineFirstSetupConnectedProps["savedIdentity"]> | null>(null);
  const savedIdentity = written ?? savedIdentityProp;
  const [ctx, setCtx] = useState<MachineSetupContext | null>(null);
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
  useEffect(() => {
    if (hasSavedIdentity && state === "idle" && ctx === null) void open();
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
          disabled={state === "loading"}
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
              : { ...prev, recordedSetupUnavailable: true }
            : prev,
        );
      }
      return relayRecordResult(out);
    });

  // The selection action the panel calls on every pick and on "Change
  // machine". Previously absent, which is why a choice never survived a
  // reload even though the store and the action were both correct.
  const onSelectMachine = async (choice: {
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
      return { ok: false, error: SAVED_MACHINE_CANNOT_BE_CLEARED };
    }
    const mod = await import(
      "@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions"
    );
    const legacyProfile = choice.legacy ? (ctx.legacyMachine?.profileId ?? null) : null;
    // THE PREFERENCE (a suggestion for the next visit) is written only for a
    // native unit; choosing the existing workflow leaves it alone.
    let pref: { ok: boolean; error?: string } = { ok: true };
    if (!choice.legacy) {
      const out =
        choice.deviceId === null
          ? await mod.clearMachineSelectionAction()
          : await mod.rememberMachineSelectionAction({
              deviceId: choice.deviceId,
              modeKey: choice.modeKey,
            });
      pref = out.ok ? { ok: true } : { ok: false, error: out.error };
    }
    const chosen =
      choice.deviceId !== null || legacyProfile !== null
        ? { deviceId: choice.deviceId, modeKey: choice.modeKey, profileId: legacyProfile }
        : null;
    // THE RECORD: this area's own machine. A new area carries it into the
    // host's Save (one transaction); a saved area writes it now.
    if (!blockId) {
      onIdentityDraft?.(chosen, true);
      return pref;
    }
    if (chosen === null) {
      return savedIdentity && (savedIdentity.deviceId || savedIdentity.profileId)
        ? { ok: false, error: SAVED_MACHINE_CANNOT_BE_CLEARED }
        : pref;
    }
    const saved = await mod.recordBlockMachineIdentityAction({
      clientId,
      sessionId,
      blockId,
      deviceId: chosen.deviceId,
      modeKey: chosen.modeKey,
      profileId: chosen.profileId,
      expectedUpdatedAt: blockVersion ?? null,
    });
    if (saved.ok) {
      setWritten({ profileId: chosen.profileId, deviceId: chosen.deviceId, modeKey: chosen.modeKey });
      if (saved.updatedAt) onBlockVersion?.(saved.updatedAt);
    }
    return saved.ok ? pref : { ok: false, error: saved.error };
  };

  // A NEW AREA STARTS ON THIS CLIENT's LAST MACHINE when there is one (Photos R2): the previous machine is
  // the client's, not the practitioner's last pick anywhere. The remembered preference is the fallback, and
  // an area that already has a saved identity is never touched.
  const hasSaved = Boolean(savedIdentity && (savedIdentity.deviceId || savedIdentity.profileId));
  // NEW AREAS ONLY (Insurance N-7): an existing identity-less area (pre-0301 data) opens exactly as before.
  const newAreaLast = !hasSaved && !blockId ? (ctx.clientLastMachine ?? null) : null;

  return (
    <MachineFirstSetupPanel
      scope={ctx.scope}
      devices={ctx.devices}
      initialDeviceId={newAreaLast ? newAreaLast.deviceId : (ctx.remembered?.deviceId ?? null)}
      // The remembered MODE, which the loader has always resolved and which
      // nothing forwarded - so the panel silently used each profile's first
      // active mode and recorded against the wrong field contract.
      initialModeKey={newAreaLast ? newAreaLast.modeKey : (ctx.remembered?.modeKey ?? null)}
      // The server resolved the stored selection; when it is not usable the
      // panel shows nothing chosen and states the reason, rather than an
      // empty picker beside a claim that a machine is remembered.
      unavailableSelection={ctx.rememberedUnavailable}
      // The unit this client's last setup used, offered (not selected) when
      // nothing is remembered. Forwarded here or it is inert in the real route.
      suggestedMachine={ctx.suggestedMachine}
      // A reopened visit's last saved unit and mode. Forwarded here or it is
      // inert in the real route.
      restoredSelection={
        savedIdentity?.deviceId && savedIdentity.modeKey
          ? { deviceId: savedIdentity.deviceId, modeKey: savedIdentity.modeKey }
          : ctx.restoredSelection
      }
      // The existing workflow as a choice in THE selector, and whether this
      // area was saved as it.
      legacyMachine={ctx.legacyMachine}
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
      blockId={blockId}
      // CREATE MODE. Forwarded rather than recreated here, and the
      // context-forwarding guard cannot see this one because it is not a
      // context field - so it is pinned by its own source assertion in
      // tests/components/machine-first-setup-panel.test.ts.
      onSettingDraft={onSettingDraft}
      // FORWARDED. Five values in this lane have been computed correctly and
      // dropped at a hop exactly like this one.
      onRevisionUnresolved={onRevisionUnresolved}
      settingDraftFrozen={settingDraftFrozen}
      onSelectMachine={select ?? onSelectMachine}
      onRecord={onRecord}
    />
  );
}
