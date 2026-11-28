import { createClient } from "@/lib/supabase/server";
import { isSelfServeCheckoutEnabled } from "./plans";
import type { TeamSeats } from "./team-seats";

export async function getOwnerTeamSeats(
  studioId: string,
): Promise<TeamSeats | null> {
  if (!isSelfServeCheckoutEnabled(process.env)) return null;
  const db = await createClient();
  const { data, error } = await db.rpc("my_hone_team_seats", {
    p_studio: studioId,
  });
  if (error) throw new Error("Could not load the studio's plan limits.");
  return data;
}
