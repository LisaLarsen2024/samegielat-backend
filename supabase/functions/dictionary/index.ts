import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ORIGINS = ["http://localhost:5173","http://localhost:3000","http://localhost:4173","https://samegielat.surge.sh"];
const POS: Record<string, string> = { n:"substantiv", v:"verb", vblex:"verb", adj:"adjektiv", adv:"adverb", pr:"preposisjon", prn:"pronomen", det:"determinativ", cnjcoo:"konjunksjon", cnjsub:"subjunksjon", ij:"interjeksjon", num:"tallord", np:"egennavn" };

function cors(o: string) {
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : "",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-info, apikey",
  };
}
function json(d: unknown, s: number, o: string) {
  return new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json", ...cors(o) } });
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") ?? "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405, origin);

  let word: string, sourceLang: string | null, targetLang: string | null, limit: number;
  try {
    const body = await req.json();
    word = body.word;
    sourceLang = body.sourceLang || null;
    targetLang = body.targetLang || null;
    limit = Math.min(body.limit || 20, 50);
  } catch { return json({ error: "Invalid JSON" }, 400, origin); }

  if (!word?.trim()) return json({ error: "Missing word" }, 400, origin);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data, error } = await sb.rpc("lookup_dictionary", {
    p_word: word.trim(), p_source_lang: sourceLang, p_target_lang: targetLang, p_limit: limit,
  });

  if (error) {
    let q = sb.from("dictionary").select("id, source_lang, target_lang, source_word, target_word, source_pos").ilike("source_word", `${word.trim()}%`).limit(limit);
    if (sourceLang) q = q.eq("source_lang", sourceLang);
    if (targetLang) q = q.eq("target_lang", targetLang);
    const { data: fb, error: fbErr } = await q;
    if (fbErr) return json({ error: "Lookup failed" }, 500, origin);
    return json({ results: (fb || []).map((r: Record<string, string|null>) => ({ ...r, pos_label: r.source_pos ? POS[r.source_pos] || r.source_pos : null })), word: word.trim(), count: fb?.length || 0 }, 200, origin);
  }

  return json({ results: (data || []).map((r: Record<string, string|null>) => ({ ...r, pos_label: r.source_pos ? POS[r.source_pos] || r.source_pos : null })), word: word.trim(), count: data?.length || 0 }, 200, origin);
});
