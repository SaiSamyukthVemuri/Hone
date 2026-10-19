"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { concernTargetFromValue } from "@/lib/delivery/concerns";

// DELIVERY-VISIBILITY-04. The studio owner records "the client says they did
// not receive it" for one message about one appointment
// (report_delivery_concern, 0221). Runs with the owner's OWN session: the
// database refuses anyone who is not the studio's owner, so this action adds
// no authority of its own. It changes no delivery status, sends nothing and
// stores no free text.

export type ReportConcernState =
  | { status: "idle" }
  | { status: "reported" | "already_open"; ledgerStatus: string }
  | { status: "error"; message: string };

export async function reportDeliveryConcernAction(
  _prev: ReportConcernState,
  formData: FormData,
): Promise<ReportConcernState> {
  const studioId = formData.get("studio_id");
  const appointmentId = formData.get("appointment_id");
  const target = concernTargetFromValue(formData.get("message"));
  if (typeof studioId !== "string" || typeof appointmentId !== "string" || !target) {
    return { status: "error", message: "Choose which message the client did not receive." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("report_delivery_concern", {
    p_studio_id: studioId,
    p_appointment_id: appointmentId,
    p_channel: target.channel,
    p_purpose: target.purpose,
  });
  if (error) {
    return {
      status: "error",
      message:
        error.code === "42501"
          ? "Only the studio owner can report a delivery concern."
          : "The concern could not be saved. Please try again.",
    };
  }
  const row = (Array.isArray(data) ? data[0] : data) as { result?: string; ledger_status?: string } | null;
  if (row?.result === "reported" || row?.result === "already_open") {
    revalidatePath(`/calendar/${appointmentId}`);
    return { status: row.result, ledgerStatus: row.ledger_status ?? "no_record" };
  }
  return { status: "error", message: "The concern could not be saved. Please try again." };
}
