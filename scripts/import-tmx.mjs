import { createClient } from "@supabase/supabase-js";
import { parseString } from "xml2js";
import { promisify } from "util";

const parseXml = promisify(parseString);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Mangler env vars. Kjor slik:");
  console.error("SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_KEY=eyJ... node scripts/import-tmx.mjs");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const TMX_SOURCES = [
  { label: "Nordsamisk - Norsk", sourceLang: "sme", targetLang: "nob", url: "https://gtsvn.uit.no/biggies/trunk/mt/omegat/sme-nob/tm/" },
  { label: "Norsk - Nordsamisk", sourceLang: "nob", targetLang: "sme", url: "https://gtsvn.uit.no/biggies/trunk/mt/omegat/nob-sme/tm/" },
  { label: "Nordsamisk - Lulesamisk", sourceLang: "sme", targetLang: "smj", url: "https://gtsvn.uit.no/biggies/trunk/mt/omegat/sme-smj/tm/" },
  { label: "Nordsamisk - Sorsamisk", sourceLang: "sme", targetLang: "sma", url: "https://gtsvn.uit.no/biggies/trunk/mt/omegat/sme-sma/tm/" },
  { label: "Sorsamisk - Norsk", sourceLang: "sma", targetLang: "nob", url: "https://gtsvn.uit.no/biggies/trunk/mt/omegat/sma-nob/tm/" },
];

function normalizeLang(code) {
  const map = { se:"sme", sme:"sme", nb:"nob", nob:"nob", no:"nob", nor:"nob", smj:"smj", sma:"sma", smn:"smn", sms:"sms", fi:"fin", sv:"swe" };
  return map[code] || code;
}

function extractPairs(xmlData, sourceLang, targetLang) {
  const pairs = [];
  if (!xmlData?.tmx?.body?.[0]?.tu) return pairs;
  for (const tu of xmlData.tmx.body[0].tu) {
    if (!tu.tuv || tu.tuv.length < 2) continue;
    let src = null, tgt = null;
    for (const tuv of tu.tuv) {
      const lang = tuv.$?.["xml:lang"] || tuv.$?.lang || "";
      const normalized = normalizeLang(lang.toLowerCase().replace(/-.*$/, ""));
      const seg = tuv.seg?.[0];
      const text = (typeof seg === "string" ? seg : seg?._ || "").trim();
      if (!text) continue;
      if (normalized === sourceLang) src = text;
      else if (normalized === targetLang) tgt = text;
    }
    if (src && tgt) pairs.push({ source_lang: sourceLang, target_lang: targetLang, source_text: src, target_text: tgt });
  }
  return pairs;
}

async function insertPairs(pairs) {
  if (!pairs.length) return 0;
  let inserted = 0;
  for (let i = 0; i < pairs.length; i += 500) {
    const batch = pairs.slice(i, i + 500);
    const { error } = await supabase.from("translation_memory").insert(batch);
    if (error) console.warn("  Batch feil:", error.message);
    else inserted += batch.length;
    if (pairs.length > 500) process.stdout.write(`\r  Importert: ${Math.round(((i + batch.length) / pairs.length) * 100)}%`);
  }
  if (pairs.length > 500) process.stdout.write("\n");
  return inserted;
}

async function fetchTmxUrls(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const html = await resp.text();
    const urls = [];
    const regex = /href="([^"]+\.tmx)"/gi;
    let m;
    while ((m = regex.exec(html)) !== null) {
      urls.push(m[1].startsWith("http") ? m[1] : url.replace(/\/$/, "") + "/" + m[1]);
    }
    return urls;
  } catch { return []; }
}

async function main() {
  console.log("Samegielat TMX-import starter\n");
  let total = 0;

  for (const source of TMX_SOURCES) {
    console.log(`\n${source.label} (${source.sourceLang} -> ${source.targetLang})`);
    const tmxUrls = await fetchTmxUrls(source.url);

    if (tmxUrls.length === 0) {
      console.log("  Ingen TMX-filer funnet, prover direkte...");
      const guesses = [
        source.url + `${source.sourceLang}${source.targetLang}.tmx`,
        source.url + `${source.sourceLang}-${source.targetLang}.tmx`,
      ];
      let found = false;
      for (const guess of guesses) {
        try {
          const resp = await fetch(guess);
          if (!resp.ok) continue;
          const xml = await resp.text();
          console.log(`  Mottatt ${(xml.length / 1024).toFixed(0)} KB`);
          const parsed = await parseXml(xml);
          const pairs = extractPairs(parsed, source.sourceLang, source.targetLang);
          if (pairs.length > 0) {
            console.log(`  Fant ${pairs.length} setningspar`);
            total += await insertPairs(pairs);
            found = true;
            break;
          }
        } catch {}
      }
      if (!found) console.log("  Ingen data funnet");
      continue;
    }

    console.log(`  Fant ${tmxUrls.length} TMX-fil(er)`);
    for (const tmxUrl of tmxUrls) {
      try {
        console.log(`  Laster ned: ${tmxUrl.split("/").pop()}`);
        const resp = await fetch(tmxUrl);
        if (!resp.ok) continue;
        const xml = await resp.text();
        console.log(`  ${(xml.length / 1024).toFixed(0)} KB`);
        const parsed = await parseXml(xml);
        const pairs = extractPairs(parsed, source.sourceLang, source.targetLang);
        console.log(`  ${pairs.length} setningspar`);
        if (pairs.length > 0) total += await insertPairs(pairs);
      } catch (err) { console.warn(`  Feil: ${err.message}`); }
    }
  }

  console.log(`\nFerdig! Totalt importert: ${total} setningspar`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
