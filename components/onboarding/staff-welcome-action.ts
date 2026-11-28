"use server";

import { revalidatePath } from "next/cache";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { requireReceptionistWithStudio } from "@/lib/desk/guard";
import {
  staffWelcomeKey,
  type StaffRole,
} from "@/lib/onboarding/staff-welcome";

export async function completeStaffWelcome(
  role: StaffRole,
  expected: string,
): Promise<boolean> {
  if (process.env.HONE_STAFF_ONBOARDING_ENABLED !== "true") return false;
  let id: string;
  if (role === "receptionist") {
    id = (await requireReceptionistWithStudio()).receptionistId;
  } else if (role === "practitioner") {
    const { practitioner } = await requirePractitionerWithStudio();
    if (practitioner.role !== role) return false;
    id = practitioner.id;
  } else return false;
  if (id !== expected) return false;
  const db = await createClient();
  // Personal display preference only. Membership and permissions come from the guards.
  const { error } = await db.auth.updateUser({
    data: { [staffWelcomeKey(role, id)]: true },
  });
  if (error) return false;
  revalidatePath(role === "receptionist" ? "/desk" : "/dashboard");
  return true;
}
