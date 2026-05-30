import type { DB } from "./types";
import { supabase, isSupabaseConfigured } from "./supabase";

const TABLE = "erp_state";
const STATE_ID = "amrest-main";

export async function fetchRemoteDB(): Promise<DB | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select("data")
    .eq("id", STATE_ID)
    .maybeSingle();

  if (error) throw error;
  return (data?.data as DB) || null;
}

export async function saveRemoteDB(db: DB) {
  if (!isSupabaseConfigured || !supabase) return;
  const { error } = await supabase
    .from(TABLE)
    .upsert({ id: STATE_ID, data: db }, { onConflict: "id" });

  if (error) throw error;
}