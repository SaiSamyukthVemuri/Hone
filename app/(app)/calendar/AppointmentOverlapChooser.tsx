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
import { chooserSummaryRows } from "@/lib/calendar/appointment-lanes";

// The one place this surface reads the stored client name (the name census records one read per file).
function overlapClientName(a: AppointmentWithPractitionerColor): string {
  return a.client?.name?.trim() || "Client";
}

// What a chooser button shows for SEVERAL appointments: each client and start time inside the span the button covers,
// "+N more" when the span is short, and the count alone when the height is unknown or too small. In a narrow column the
// start time is hidden (container query on the button) so the name keeps the room. Display only.
export function OverlapSummaryRows({ members, height, tz, timeFormat }: {
  members: ReadonlyArray<AppointmentWithPractitionerColor>; height: number; tz: string; timeFormat: TimeFormat;
}) {
  const rows = chooserSummaryRows(members.length, height);
  if (rows.shown === 0) return <>
    <span className="block font-semibold">{members.length} appointments</span>
    <span className="block tabular-nums">{formatTimeForStudio(new Date(members[0].starts_at), tz, timeFormat)}</span>
  </>;
  return <>
    {members.slice(0, rows.shown).map((m) => {
      const name = overlapClientName(m);
      return (
        <span key={m.id} data-chooser-row="" className="flex h-[14px] items-center gap-1 text-[11px] leading-[14px]">
          <span className="hidden shrink-0 tabular-nums opacity-80 @min-[7rem]:inline">{formatTimeForStudio(new Date(m.starts_at), tz, timeFormat)}</span>
          <span className="truncate font-semibold" title={name}>{name}</span>
        </span>
      );
    })}
    {rows.more > 0 && <span className="block h-[14px] text-[11px] font-semibold leading-[14px]">+{rows.more} more</span>}
  </>;
}

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
    <span className="block whitespace-normal font-semibold">{overlapClientName(a)}</span>
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
