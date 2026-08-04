// public/js/storage-config.js
//
// Enables uploading files DIRECTLY from the browser to Supabase
// Storage, bypassing our own Vercel functions — which have a hard
// 4.5 MB request body limit at the platform level (see
// api/deal-sheets/[id]/attachments.js for the full explanation).
//
// This is a SEPARATE file from config.js on purpose: config.js holds
// the real MSAL/Entra client credentials and must never be touched
// blindly. This file only needs Supabase's PUBLIC "anon" key, which
// is safe to expose in the browser by Supabase's own design — access
// is governed by Row Level Security and Storage policies, not by
// keeping the key secret. It is NOT the service-role key (that one
// stays server-side only, in Vercel's environment variables, and
// must never appear here).
//
// ---- fill these two values in from your Supabase dashboard ----
//   Dashboard → Settings → API
//     "Project URL"      → SUPABASE_URL
//     "anon" / "public" key (NOT "service_role") → SUPABASE_ANON_KEY
const SUPABASE_URL = "https://mcurpiuaezilcnnuqvnm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jdXJwaXVhZXppbGNubnVxdm5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1MTA5MTEsImV4cCI6MjA5NjA4NjkxMX0.nPts4jRqwTm_CZsD2OUmO5ZgjTKIMk1-CLsNqRYCOxw";
// ------------------------------------------------------------------

const STORAGE_BUCKET = "deal-documents"; // must match BUCKET in attachments.js

(function () {
  if (SUPABASE_URL.includes("YOUR-PROJECT-REF") || SUPABASE_ANON_KEY === "YOUR-ANON-PUBLIC-KEY") {
    console.warn(
      "storage-config.js: SUPABASE_URL / SUPABASE_ANON_KEY are still placeholders. " +
      "Large-file attachment uploads will not work until these are filled in from " +
      "Supabase Dashboard → Settings → API."
    );
  }
  window.DealSheetStorage = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  window.DEAL_STORAGE_BUCKET = STORAGE_BUCKET;
})();
