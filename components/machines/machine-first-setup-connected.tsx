"use client";

import { useCallback, useState } from "react";

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
// WHAT IT STILL DOES NOT DO. It sends no studio id and no practitioner id,
// because `loadMachineSetupContext` accepts none. Identity is derived from the
// authenticated session on the server, every call.

export type MachineFirstSetupConnectedProps = {
  /** The treatment block being charted, from the host form. */
  blockId?: string | null;
  /** Injected by tests; production uses the server action. */
  load?: () => Promise<MachineSetupContext>;
  /** Injected by tests; production uses the server action. */
  record?: MachineFirstSetupPanelRecord;
};

type MachineFirstSetupPanelRecord = NonNullable<
  Parameters<typeof MachineFirstSetupPanel>[0]["onRecord"]
>;

export function MachineFirstSetupConnected({
  blockId = null,
  load,
  record,
}: MachineFirstSetupConnectedProps = {}) {
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
          return mod.loadMachineSetupContext();
        });
      setCtx(await loader());
      setState("idle");
    } catch {
      // Charting below is unaffected by a failed identity read, so this is
      // reported in place rather than escalated.
      setState("failed");
    }
  }, [load]);

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
        <button
          type="button"
          onClick={open}
          disabled={state === "loading"}
          className="self-start rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          data-testid="machine-first-open"
        >
          {state === "loading" ? "Loading…" : "Choose machine"}
        </button>
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
      const out = await mod.recordReadingsAction(input);
      return out.ok ? { ok: true } : { ok: false, error: out.error };
    });

  return (
    <MachineFirstSetupPanel
      scope={ctx.scope}
      devices={ctx.devices}
      initialDeviceId={ctx.remembered?.deviceId ?? null}
      inventoryReason={ctx.inventoryReason}
      persistence={ctx.persistence ?? NO_PERSISTENCE}
      // The catalogue is whatever the SERVER resolved, so the synthetic demo
      // profile reaches the client only when the server's gate allowed it.
      catalogue={ctx.catalogue.length > 0 ? ctx.catalogue : undefined}
      canManageMachines={ctx.canManageMachines}
      priorSetup={ctx.priorSetup}
      blockId={blockId}
      onRecord={onRecord}
    />
  );
}
