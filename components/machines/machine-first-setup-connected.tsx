"use client";

import { useCallback, useState } from "react";

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
  onSettingDraft?: NonNullable<
    Parameters<typeof MachineFirstSetupPanel>[0]["onSettingDraft"]
  >;
  /** Injected by tests; production uses the server action. */
  select?: (choice: {
    deviceId: string | null;
    modeKey: string | null;
  }) => Promise<{ ok: boolean; error?: string }>;
};

type MachineFirstSetupPanelRecord = NonNullable<
  Parameters<typeof MachineFirstSetupPanel>[0]["onRecord"]
>;

export function MachineFirstSetupConnected({
  blockId = null,
  clientId,
  sessionId,
  load,
  select,
  record,
  onSettingDraft,
  settingDraftFrozen = false,
}: MachineFirstSetupConnectedProps) {
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
      });
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
                }
              : { ...prev, recordedSetupUnavailable: true }
            : prev,
        );
      }
      return out.ok
        ? {
            ok: true,
            captures: out.captures,
            written: out.written,
            reused: out.reused,
          }
        : { ok: false, error: out.error };
    });

  // The selection action the panel calls on every pick and on "Change
  // machine". Previously absent, which is why a choice never survived a
  // reload even though the store and the action were both correct.
  const onSelectMachine = async (choice: {
    deviceId: string | null;
    modeKey: string | null;
  }) => {
    const mod = await import(
      "@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions"
    );
    const out =
      choice.deviceId === null
        ? await mod.clearMachineSelectionAction()
        : await mod.rememberMachineSelectionAction({
            deviceId: choice.deviceId,
            modeKey: choice.modeKey,
          });
    return out.ok ? { ok: true } : { ok: false, error: out.error };
  };

  return (
    <MachineFirstSetupPanel
      scope={ctx.scope}
      devices={ctx.devices}
      initialDeviceId={ctx.remembered?.deviceId ?? null}
      // The remembered MODE, which the loader has always resolved and which
      // nothing forwarded - so the panel silently used each profile's first
      // active mode and recorded against the wrong field contract.
      initialModeKey={ctx.remembered?.modeKey ?? null}
      // The server resolved the stored selection; when it is not usable the
      // panel shows nothing chosen and states the reason, rather than an
      // empty picker beside a claim that a machine is remembered.
      unavailableSelection={ctx.rememberedUnavailable}
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
      settingDraftFrozen={settingDraftFrozen}
      onSelectMachine={select ?? onSelectMachine}
      onRecord={onRecord}
    />
  );
}
