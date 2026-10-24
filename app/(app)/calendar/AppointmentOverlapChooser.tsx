"use client";

import Link from "next/link";
import type { StudioTimedBlock } from "@/lib/types/database";
import { TIMED_BLOCK_LABEL } from "./calendar-format";
import type { AppointmentWithPractitionerColor } from "@/lib/booking/queries";
import { formatTimeForStudio, type TimeFormat } from "@/lib/booking/tz";
import { useDialogKeyboard } from "@/components/use-dialog-keyboard";
import { appointmentDisplayStatus, appointmentStatusTag } from "./appointment-display-status";
import { timeRangeLabel } from "./calendar-format";
import { calendarBlockScopeLabel, type BlockScopeNames } from "@/lib/calendar/block-scope";

export function OverlapAppointmentSummary({ appointment: a, tz, timeFormat }: {
  appointment: AppointmentWithPractitionerColor; tz: string; timeFormat: TimeFormat;
}) {
  const range = timeRangeLabel(
    formatTimeForStudio(new Date(a.starts_at), tz, timeFormat),
    a.ends_at ? formatTimeForStudio(new Date(a.ends_at), tz, timeFormat) : null,
  );
  const status = appointmentDisplayStatus(a.status, a.ends_at);
  const tag = appointmentStatusTag(status);
  // A no-show leads the summary, where a clipped card still shows it.
  const noShow = status === "no_show";
  return <>
    {noShow ? <span className="block text-xs font-semibold">No-show</span> : null}
    <span className="block whitespace-normal font-semibold">{a.client?.name?.trim() || "Client"}</span>
    <span className="block text-xs tabular-nums">{range}{tag && !noShow ? ` · ${tag}` : ""}</span>
    {a.practitioner?.display_name?.trim() ? <span className="block text-xs">{a.practitioner.display_name.trim()}</span> : null}
    {a.service?.name?.trim() ? <span className="block text-xs opacity-70">{a.service.name.trim()}</span> : null}
  </>;
}

// Read-only disclosure of the exact objects already loaded for this day.
// No booking/chart/provider action occurs on opening, closing or selection.
type BlockChoices = { timedBlocks?: undefined; onSelectBlock?: undefined } | {
  timedBlocks: ReadonlyArray<StudioTimedBlock>;
  onSelectBlock: (block: StudioTimedBlock) => void;
};
export function AppointmentOverlapChooser({ appointments, timedBlocks = [], tz, timeFormat, returnTo, onClose, onSelect, onSelectBlock, blockScopeNames }: {
  appointments: ReadonlyArray<AppointmentWithPractitionerColor>;
  tz: string; timeFormat: TimeFormat; returnTo: string;
  // BLOCK-SCOPE F3: present under practitioner capacity; names each block's scope.
  blockScopeNames?: BlockScopeNames;
  onClose: () => void;
  onSelect?: (appointment: AppointmentWithPractitionerColor) => void;
} & BlockChoices) {
  const open = appointments.length > 0 || timedBlocks.length > 0;
  const chooserLabel = timedBlocks.length ? "Choose a calendar item" : "Choose an appointment";
  const { panelRef, initialFocusRef } = useDialogKeyboard<HTMLDivElement, HTMLButtonElement>({ open, onClose });
  if (!open) return null;
  const rowClasses = "block min-h-[44px] min-w-[44px] w-full rounded-md border border-neutral-300 px-3 py-3 text-left text-sm hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-offset-2 dark:border-neutral-700 dark:hover:bg-neutral-900";
  return (
    <div role="dialog" aria-modal="true" aria-label={chooserLabel} className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label={timedBlocks.length ? "Dismiss calendar item chooser" : "Dismiss appointment chooser"} onClick={onClose}
        className="absolute inset-0 min-h-[44px] min-w-[44px] bg-black/30" />
      <div ref={panelRef} tabIndex={-1} className="relative z-10 flex max-h-[80dvh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-xl bg-white p-4 shadow-xl dark:bg-neutral-950">
        <header className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{chooserLabel}</h2>
          <button ref={initialFocusRef} type="button" onClick={onClose} className="min-h-[44px] min-w-[44px] rounded-md border border-neutral-300 px-3 text-sm dark:border-neutral-700">Close</button>
        </header>
        {appointments.map((a) => onSelect ? (
          <button key={a.id} type="button" className={rowClasses} onClick={() => { onClose(); onSelect(a); }}>
            <OverlapAppointmentSummary appointment={a} tz={tz} timeFormat={timeFormat} />
          </button>
        ) : (
          <Link key={a.id} href={`/calendar/${a.id}${returnTo}`} className={rowClasses} onClick={onClose}>
            <OverlapAppointmentSummary appointment={a} tz={tz} timeFormat={timeFormat} />
          </Link>
        ))}
        {onSelectBlock && timedBlocks.map(block => (
          <button key={`block:${block.id}`} type="button" className={rowClasses}
            data-timed-block-id={block.id}
            onClick={() => { onClose(); onSelectBlock(block); }}>
            <span className="block font-semibold">{TIMED_BLOCK_LABEL[block.category] ?? "Unavailable"}</span>
            <span className="block text-xs tabular-nums">{timeRangeLabel(
              formatTimeForStudio(new Date(block.starts_at), tz, timeFormat),
              formatTimeForStudio(new Date(block.ends_at), tz, timeFormat),
            )}</span>
            {blockScopeNames ? <span className="block text-xs" data-block-scope="">{calendarBlockScopeLabel(block.practitioner_id, blockScopeNames)}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
