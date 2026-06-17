import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ORIGINS = ["http://localhost:5173","http://localhost:3000","http://localhost:4173","http://localhost:5177","http://localhost:5178","https://samegielat.surge.sh","https://samegielat.vercel.app"];
const VALID_LANGS = new Set(["sme","smj","sma"]);
const LANG_NAMES: Record<string,string> = { sme:"nordsamisk (davvisámegiella)", smj:"lulesamisk (julevsámegiella)", sma:"sørsamisk (åarjelsaemien gïele)" };

// MERK: Vi bruker IKKE hardkodede anchor-eksempler skapt av AI. All "ground truth"
// hentes dynamisk fra dictionary-tabellen (GiellaLT/Apertium-data) ved hver request,
// så modellen kun ser verifiserte par fra autoritative kilder.
// For nob→smj og nob→sma finnes ingen direkte par i dict — kun via sme.

const rateMap = new Map<string,{c:number;r:number}>();

function cors(o:string){return{"Access-Control-Allow-Origin":ORIGINS.includes(o)?o:"","Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization, x-client-info, apikey"};}
function json(d:unknown,s:number,o:string){return new Response(JSON.stringify(d),{status:s,headers:{"Content-Type":"application/json",...cors(o)}});}

Deno.serve(async(req)=>{
  const origin=req.headers.get("Origin")??"";
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors(origin)});
  if(req.method!=="POST")return json({error:"Use POST"},405,origin);

  const ip=req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()??"?";
  const now=Date.now();
  const rl=rateMap.get(ip);
  if(!rl||now>rl.r)rateMap.set(ip,{c:1,r:now+60000});
  else if(++rl.c>30)return json({error:"Rate limit"},429,origin);

  let text:string,targetLang:string;
  try{const b=await req.json();text=b.text;targetLang=b.targetLang;}
  catch{return json({error:"Invalid JSON"},400,origin);}

  if(!text?.trim())return json({error:"Missing text"},400,origin);
  if(text.length>3000)return json({error:"Max 3000 chars"},400,origin);
  if(!VALID_LANGS.has(targetLang))return json({error:`Invalid targetLang. Use: ${[...VALID_LANGS].join(", ")}`},400,origin);

  const apiKey=Deno.env.get("ANTHROPIC_API_KEY");
  if(!apiKey)return json({error:"API key not configured"},500,origin);

  const sb=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const langName=LANG_NAMES[targetLang];

  // ─── 1. DICTIONARY-OPPSLAG på input-ord (verifiserte ord-par) ──────────
  // Splitt input i ord, slå opp i dictionary (GiellaLT/Apertium), bygg
  // garantert sann kontekst fra Lisas egne datasett.
  const words = text.toLowerCase()
    .replace(/[^\p{L}\s-]/gu, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && w.length < 30)
    .slice(0, 20);

  let dictAnchors = "";
  if (words.length > 0) {
    try {
      // Step 1: nob → sme (vi har 87k par direkte)
      const { data: nob2sme } = await sb.from("dictionary")
        .select("source_word, target_word")
        .eq("source_lang", "nob")
        .eq("target_lang", "sme")
        .in("source_word_lower", words)
        .limit(40);

      if (nob2sme && nob2sme.length > 0) {
        // Dedupliser per source_word, behold første variant
        const seen = new Set<string>();
        const unique = nob2sme.filter((p: {source_word: string; target_word: string}) => {
          const k = p.source_word.toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k); return true;
        });

        if (targetLang === "sme") {
          // Direkte: vi har nob→sme i hånda
          dictAnchors = unique
            .map((p: {source_word: string; target_word: string}) =>
              `Norsk: ${p.source_word}\n${langName}: ${p.target_word}`)
            .join("\n");
        } else {
          // Bro via nordsamisk: nob→sme→smj/sma
          const smeWords = unique.map((p: {target_word: string}) =>
            p.target_word.toLowerCase());
          const { data: sme2tgt } = await sb.from("dictionary")
            .select("source_word, target_word")
            .eq("source_lang", "sme")
            .eq("target_lang", targetLang)
            .in("source_word_lower", smeWords)
            .limit(40);

          if (sme2tgt && sme2tgt.length > 0) {
            const bridgeMap = new Map<string, string>();
            for (const p of sme2tgt) {
              const k = p.source_word.toLowerCase();
              if (!bridgeMap.has(k)) bridgeMap.set(k, p.target_word);
            }
            const bridged = unique
              .map((p: {source_word: string; target_word: string}) => {
                const tgt = bridgeMap.get(p.target_word.toLowerCase());
                return tgt ? `Norsk: ${p.source_word}\n${langName}: ${tgt}` : null;
              })
              .filter((x: string | null) => x !== null);
            dictAnchors = bridged.join("\n");
          }
        }
      }
    } catch(e) { console.error("Dict lookup error:", e); }
  }

  // ─── 2. TRANSLATION MEMORY: lange offisielle setninger som ekstra kontekst ──
  let tmExamples = "";
  try{
    const{data}=await sb.from("translation_memory")
      .select("source_text,target_text")
      .eq("source_lang","nob")
      .eq("target_lang",targetLang)
      .limit(40);

    if(data&&data.length>0){
      tmExamples=data.map((p:{source_text:string;target_text:string})=>
        `Norsk: ${p.source_text}\n${langName}: ${p.target_text}`
      ).join("\n");
    }else{
      const{data:rev}=await sb.from("translation_memory")
        .select("source_text,target_text")
        .eq("source_lang",targetLang)
        .eq("target_lang","nob")
        .limit(40);

      if(rev&&rev.length>0){
        tmExamples=rev.map((p:{source_text:string;target_text:string})=>
          `Norsk: ${p.target_text}\n${langName}: ${p.source_text}`
        ).join("\n");
      }
    }
  }catch(e){console.error("TMX fetch error:",e);}

  // Bygg samlet kontekst: dict (verifiserte ord) FØRST, så TM (lange setninger)
  const allExamples = [dictAnchors, tmExamples].filter(s => s.length > 0).join("\n");

  const prompt=`Du er en ekspert oversetter fra norsk til ${langName}.

VIKTIGE REGLER:
- Svar KUN på ${langName}. Bruk ALDRI finsk, svensk, engelsk eller norsk i oversettelsen.
- ${langName.split(" ")[0]} er et samisk språk — ikke bland med finsk eller andre nordiske språk.
- Eksemplene under er hentet direkte fra autoritative kilder: GiellaLT (UiT Norges arktiske universitet), Apertium åpne ordbøker, og offisielle Sametings-tekster. Behandle dem som ground truth.
- Hvis input-ord finnes blant ordbok-eksemplene, BRUK den verifiserte oversettelsen.
- Hvis du er usikker på oversettelsen, skriv "Usikker oversettelse — sjekk med samiskspråklig" istedenfor å gjette.
- Bruk standard, daglig språkbruk. Ikke arkaisk eller overformelt.
- Svar KUN med oversettelsen, ingen forklaringer, ingen anførselstegn.

Verifiserte eksempler fra ordbøker og parallelle korpus:

${allExamples}

Oversett nå denne teksten:

Norsk: ${text.trim()}
${langName}:`;

  try{
    const r=await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "x-api-key":apiKey,
        "anthropic-version":"2023-06-01",
      },
      body:JSON.stringify({
        model:"claude-sonnet-4-6",
        max_tokens:1000,
        messages:[{role:"user",content:prompt}],
      }),
      signal:AbortSignal.timeout(30000),
    });

    if(!r.ok){
      const err=await r.json();
      console.error("Claude error:",err);
      return json({error:err.error?.message||"Translation failed"},502,origin);
    }

    const d=await r.json();
    const translated=d.content[0].text.trim();

    return json({translatedText:translated,targetLang,sourceText:text.trim()},200,origin);
  }catch(e){
    if(e instanceof DOMException&&e.name==="TimeoutError")return json({error:"Timeout"},504,origin);
    console.error("Error:",e);
    return json({error:"Internal error"},500,origin);
  }
});
