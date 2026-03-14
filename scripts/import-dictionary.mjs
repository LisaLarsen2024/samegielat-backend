import { createClient } from "@supabase/supabase-js";
import { parseString } from "xml2js";
import { promisify } from "util";

const parseXml = promisify(parseString);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Mangler env vars.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const BIDIX_SOURCES = [
  { label: "sme-nob", sourceLang: "sme", targetLang: "nob", url: "https://raw.githubusercontent.com/apertium/apertium-sme-nob/main/apertium-sme-nob.sme-nob.dix" },
  { label: "sme-smj", sourceLang: "sme", targetLang: "smj", url: "https://raw.githubusercontent.com/apertium/apertium-sme-smj/main/apertium-sme-smj.sme-smj.dix" },
  { label: "sme-sma", sourceLang: "sme", targetLang: "sma", url: "https://raw.githubusercontent.com/apertium/apertium-sme-sma/main/apertium-sme-sma.sme-sma.dix" },
];

function extractText(node) {
  if (typeof node === "string") return node.trim();
  return (node?._ || "").trim().replace(/\s+/g, " ");
}

function extractPos(node) {
  const s = node?.s;
  if (Array.isArray(s) && s.length > 0) return s[0]?.$?.n || null;
  return null;
}

function extractFromBidix(xmlData, srcLang, tgtLang) {
  const entries = [];
  const sections = xmlData?.dictionary?.section || [];
  for (const section of Array.isArray(sections) ? sections : [sections]) {
    for (const entry of (section?.e || [])) {
      try {
        const restriction = entry.$?.r;
        const pair = entry.p?.[0];
        if (!pair) continue;
        const left = pair.l?.[0], right = pair.r?.[0];
        if (!left || !right) continue;
        const srcWord = extractText(left), tgtWord = extractText(right);
        if (!srcWord || !tgtWord) continue;
        const pos = extractPos(left);
        if (restriction !== "RL") entries.push({ source_lang: srcLang, target_lang: tgtLang, source_word: srcWord, target_word: tgtWord, source_pos: pos });
        if (restriction !== "LR") entries.push({ source_lang: tgtLang, target_lang: srcLang, source_word: tgtWord, target_word: srcWord, source_pos: pos });
      } catch {}
    }
  }
  return entries;
}

async function insertEntries(entries) {
  if (!entries.length) return 0;
  let inserted = 0;
  for (let i = 0; i < entries.length; i += 500) {
    const batch = entries.slice(i, i + 500);
    const { error } = await supabase.from("dictionary").insert(batch);
    if (error) console.warn("  Batch feil:", error.message);
    else inserted += batch.length;
    if (entries.length > 500) process.stdout.write(`\r  Importert: ${Math.round(((i + batch.length) / entries.length) * 100)}%`);
  }
  if (entries.length > 500) process.stdout.write("\n");
  return inserted;
}

async function main() {
  console.log("Samegielat ordbokimport starter\n");
  let total = 0;

  for (const source of BIDIX_SOURCES) {
    console.log(`${source.label}`);
    try {
      let resp = await fetch(source.url);
      if (!resp.ok) {
        const alt = source.url.replace("/main/", "/master/");
        resp = await fetch(alt);
        if (!resp.ok) { console.warn("  Ikke funnet"); continue; }
      }
      const xml = await resp.text();
      console.log(`  ${(xml.length / 1024).toFixed(0)} KB XML`);
      const parsed = await parseXml(xml);
      const entries = extractFromBidix(parsed, source.sourceLang, source.targetLang);
      console.log(`  ${entries.length} ordpar`);
      if (entries.length > 0) {
        const ins = await insertEntries(entries);
        total += ins;
        console.log(`  Importert ${ins} ordpar`);
      }
    } catch (err) { console.warn(`  Feil: ${err.message}`); }
  }

  console.log(`\nFerdig! Totalt: ${total} ordpar`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
