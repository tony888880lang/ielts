const SUPABASE_URL = "https://aocrgdaysjgfapggnpqy.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFvY3JnZGF5c2pnZmFwZ2ducHF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMzAzMzYsImV4cCI6MjA4ODcwNjMzNn0.04TRGjnjoaaCE-89qqEPeE_MbgdmBkPs3VbmyUNH3xc";

export async function createCloudClient() {
  const { createClient } = await import(
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm"
  );
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
