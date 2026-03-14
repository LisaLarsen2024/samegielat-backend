import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ORIGINS = ["http://localhost:5173","http://localhost:3000","http://localhost:4173","http://localhost:5177","http://localhost:5178","https://samegielat.surge.sh"];
const VALID_LANGS = new Set(["sme","smj","sma"]);
const LANG_NAMES: Record<string,string> = { sme:"nordsamisk (davvisámegiella)", smj:"lulesamisk (julevsámegiella)", sma:"sørsamisk (åarjelsaemien gïele)" };

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

  // Fetch examples from translation memory
  const sb=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let examples="";
  try{
    const{data}=await sb.from("translation_memory")
      .select("source_text,target_text")
      .eq("source_lang","nob")
      .eq("target_lang",targetLang)
      .limit(40);

    if(data&&data.length>0){
      examples=data.map((p:{source_text:string;target_text:string})=>
        `Norsk: ${p.source_text}\n${LANG_NAMES[targetLang]}: ${p.target_text}`
      ).join("\n");
    }else{
      // Try reverse direction pairs
      const{data:rev}=await sb.from("translation_memory")
        .select("source_text,target_text")
        .eq("source_lang",targetLang)
        .eq("target_lang","nob")
        .limit(40);

      if(rev&&rev.length>0){
        examples=rev.map((p:{source_text:string;target_text:string})=>
          `Norsk: ${p.target_text}\n${LANG_NAMES[targetLang]}: ${p.source_text}`
        ).join("\n");
      }
    }
  }catch(e){console.error("TMX fetch error:",e);}

  const langName=LANG_NAMES[targetLang];
  const prompt=examples
    ?`Du er en ekspert oversetter fra norsk til ${langName}.

Her er eksempler på korrekte oversettelser:

${examples}

Oversett nå denne teksten til ${langName}.
Svar KUN med oversettelsen, ingenting annet. Ingen forklaringer, ingen anførselstegn, bare den oversatte teksten.

Norsk: ${text.trim()}
${langName}:`
    :`Du er en ekspert oversetter fra norsk til ${langName}.
Oversett denne teksten til ${langName}.
Svar KUN med oversettelsen, ingenting annet.

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
        model:"claude-sonnet-4-20250514",
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
