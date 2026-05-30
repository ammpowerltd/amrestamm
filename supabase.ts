import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://badohemfryfmvwwszqpl.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhZG9oZW1mcnlmbXZ3d3N6cXBsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5MDczMTcsImV4cCI6MjA5NDQ4MzMxN30.4LEibQ6XmzAn1u96fh95NC9tiRTBaUJzj4sfi6OKgLs";

export const isSupabaseConfigured = true;
export const supabase = createClient(supabaseUrl, supabaseKey);