"use client";

import { useEffect, useState } from "react";

import { MachineFirstSetupPanel } from "./machine-first-setup-panel";
import { NO_PERSISTENCE } from "@/lib/machines/selection-store";
import type { MachineSetupContext } from "@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions";

// MPX-03 — the panel with its identity resolved on the server.
//
// WHY A WRAPPER. `MachineFirstSetupPanel` stays a pure function of its props,
// which is what makes its 23 render assertions worth anything: they exercise
// real markup with no transport in the way. This wrapper owns the one impure
// part - asking the server who is charting - so the panel never has to.
//
// WHAT IT DELIBERATELY DOES NOT DO. It sends no studio id and no practitioner
// id, because `loadMachineSetupContext` accepts none. The client cannot name an
// owner, so it cannot name the wrong one. Identity is derived from the
// authenticated session on the server, every call.
//
// The first paint shows the panel with no scope, which renders the honest "this
// surface does not yet know who is charting" state rather than a spinner that
// implies something is coming. When the context arrives the panel re-renders
// with the real scope, the studio's devices and the real persistence status.

export type MachineFirstSetupConnectedProps = {
  /** The treatment block being charted, from the host form. */
  blockId?: string | null;
  /**
   * Injected by tests. Production passes nothing and the server action is used,
   * which is also why this component holds no fallback identity of its own.
   */
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

  useEffect(() => {
    let live = true;
    const loader =
      load ??
      (async () => {
        const mod = await import(
          "@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions"
        );
        return mod.loadMachineSetupContext();
      });
    loader()
      .then((next) => {
        if (live) setCtx(next);
      })
      .catch(() => {
        // A failed identity read leaves the honest unscoped state standing.
        // Charting below is unaffected, so there is nothing to escalate here.
        if (live) setCtx(null);
      });
    return () => {
      live = false;
    };
  }, [load]);

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
      scope={ctx?.scope ?? null}
      devices={ctx?.devices ?? []}
      initialDeviceId={ctx?.remembered?.deviceId ?? null}
      inventoryReason={ctx?.inventoryReason ?? null}
      persistence={ctx?.persistence ?? NO_PERSISTENCE}
      // The catalogue is whatever the SERVER resolved, so the synthetic demo
      // profile reaches the client only when the server's gate allowed it.
      catalogue={ctx?.catalogue ?? undefined}
      canManageMachines={ctx?.canManageMachines ?? false}
      priorSetup={ctx?.priorSetup ?? []}
      blockId={blockId}
      onRecord={onRecord}
    />
  );
}
