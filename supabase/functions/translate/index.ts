import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APERTIUM = "https://apertium.org/apy";
const ORIGINS = ["http://localhost:5173","http://localhost:3000","http://localhost:4173","https://samegielat.surge.sh"];
const PAIRS = new Set(["sme|nob","nob|sme","sme|smj","smj|sme","sme|sma","sma|sme"]);

const rateMap = new Map<string, { c: number; r: number }>();

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

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "?";
  const now = Date.now();
  const rl = rateMap.get(ip);
  if (!rl || now > rl.r) rateMap.set(ip, { c: 1, r: now + 60000 });
  else if (++rl.c > 60) return json({ error: "Rate limit" }, 429, origin);

  let text: string, langpair: string;
  try { ({ text, langpair } = await req.json()); } catch { return json({ error: "Invalid JSON" }, 400, origin); }
  if (!text?.trim()) return json({ error: "Missing text" }, 400, origin);
  if (text.length > 5000) return json({ error: "Max 5000 chars" }, 400, origin);
  if (!PAIRS.has(langpair)) return json({ error: `Invalid langpair. Use: ${[...PAIRS].join(", ")}` }, 400, origin);

  const q = text.trim();
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: hit } = await sb.from("translation_cache").select("translated_text").eq("langpair", langpair).eq("source_text", q).maybeSingle();
  if (hit) return json({ translatedText: hit.translated_text, langpair, sourceText: q, cached: true }, 200, origin);

  try {
    const r = await fetch(`${APERTIUM}/translate?${new URLSearchParams({ q, langpair, markUnknown: "no" })}`, {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return json({ error: "Service unavailable" }, 502, origin);
    const d = await r.json();
    if (d.responseStatus !== 200) return json({ error: "Translation failed" }, 502, origin);

    const out = d.responseData.translatedText;
    sb.from("translation_cache").upsert({ langpair, source_text: q, translated_text: out }, { onConflict: "langpair,source_text" }).then(() => {});

    return json({ translatedText: out, langpair, sourceText: q, cached: false }, 200, origin);
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") return json({ error: "Timeout" }, 504, origin);
    return json({ error: "Internal error" }, 500, origin);
  }
});
