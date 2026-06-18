#!/usr/bin/env node
/**
 * Samegielat data cleanup — vokter-script
 *
 * Faseinndelt, dry-run som default, backup obligatorisk før destruktive operasjoner.
 *
 * Bruk:
 *   node scripts/cleanup-data.mjs backup
 *   node scripts/cleanup-data.mjs analyze
 *   node scripts/cleanup-data.mjs dedupe-dict           (dry-run)
 *   node scripts/cleanup-data.mjs dedupe-dict --execute (faktisk slett)
 *   node scripts/cleanup-data.mjs clean-tm              (dry-run)
 *   node scripts/cleanup-data.mjs clean-tm --execute    (faktisk slett)
 *   node scripts/cleanup-data.mjs audit
 *
 * Krever:
 *   ~/.openclaw/state/supabase-service-role-key-samegielat (chmod 600)
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const SUPABASE_URL = "https://nrnrwwheokfyfyliaczq.supabase.co";
const KEY_PATH = join(homedir(), ".openclaw/state/supabase-service-role-key-samegielat");

// Vokter-grenser
const SANITY_CAP_PCT = 5;    // ABORT hvis vi vil slette > 5% av rader
const BATCH_SIZE = 500;

function loadKey() {
  try {
    return readFileSync(KEY_PATH, "utf8").trim();
  } catch (e) {
    console.error(`✗ Kunne ikke lese ${KEY_PATH}: ${e.message}`);
    console.error(`  Hent service_role fra Supabase Dashboard og legg den der (chmod 600).`);
    process.exit(1);
  }
}

const sb = createClient(SUPABASE_URL, loadKey(), { auth: { persistSession: false } });

const args = process.argv.slice(2);
const command = args[0];
const execute = args.includes("--execute");
const dryRun = !execute;

// ─── Hjelpefunksjoner ─────────────────────────────────────────────

async function count(table, filters = {}) {
  let q = sb.from(table).select("id", { count: "exact", head: true });
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
  const { count: c, error } = await q;
  if (error) throw new Error(`count(${table}): ${error.message}`);
  return c;
}

function pct(part, whole) {
  return whole > 0 ? ((part / whole) * 100).toFixed(2) : "0.00";
}

async function tableExists(name) {
  const { error } = await sb.from(name).select("id").limit(1);
  return !error;
}

// ─── Fase 1: BACKUP ────────────────────────────────────────────────

async function backup() {
  console.log("=== FASE 1: BACKUP ===\n");
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const dictBackup = `dictionary_backup_${date}`;
  const tmBackup = `translation_memory_backup_${date}`;

  console.log(`Backup-tabeller blir:`);
  console.log(`  ${dictBackup}`);
  console.log(`  ${tmBackup}\n`);

  if (await tableExists(dictBackup)) {
    console.log(`  ⚠ ${dictBackup} finnes allerede — hopper over (idempotent)`);
  } else {
    console.log(`  → Lager ${dictBackup} (kjør SQL i Supabase Dashboard):`);
    console.log(`\n    CREATE TABLE ${dictBackup} AS SELECT * FROM dictionary;\n`);
  }

  if (await tableExists(tmBackup)) {
    console.log(`  ⚠ ${tmBackup} finnes allerede — hopper over (idempotent)`);
  } else {
    console.log(`  → Lager ${tmBackup} (kjør SQL i Supabase Dashboard):`);
    console.log(`\n    CREATE TABLE ${tmBackup} AS SELECT * FROM translation_memory;\n`);
  }

  console.log(`📋 Postgrest/Supabase JS-klienten kan ikke kjøre CREATE TABLE direkte.`);
  console.log(`   Lim inn SQL-en over i: https://supabase.com/dashboard/project/nrnrwwheokfyfyliaczq/sql/new`);
  console.log(`   Trykk RUN. Verifiser at backup-tabellene er opprettet før du går videre.`);
}

// ─── Fase 2: ANALYZE ────────────────────────────────────────────────

async function analyze() {
  console.log("=== FASE 2: ANALYZE (dry-run, ingen endringer) ===\n");

  const dictTotal = await count("dictionary");
  const tmTotal = await count("translation_memory");

  console.log(`Dictionary total: ${dictTotal.toLocaleString()} rader`);
  console.log(`Translation memory total: ${tmTotal.toLocaleString()} rader\n`);

  // Dictionary duplikater
  console.log("─── Dictionary: ekte duplikater ───");
  console.log("   (identisk på source_lang, target_lang, source_word, target_word, source_pos)\n");

  // Hent alle rader, finn duplikater i JS (Postgrest har ikke GROUP BY HAVING direkte)
  let allDictRows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb.from("dictionary")
      .select("id, source_lang, target_lang, source_word, target_word, source_pos")
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    allDictRows = allDictRows.concat(data);
    offset += 1000;
    process.stdout.write(`\r  Henter dict... ${allDictRows.length}/${dictTotal}`);
  }
  process.stdout.write("\n");

  const dictKey = (r) => `${r.source_lang}|${r.target_lang}|${r.source_word}|${r.target_word}|${r.source_pos || ""}`;
  const dictGroups = new Map();
  for (const r of allDictRows) {
    const k = dictKey(r);
    if (!dictGroups.has(k)) dictGroups.set(k, []);
    dictGroups.get(k).push(r.id);
  }

  let dictDupeRows = 0;
  let dictDupeGroups = 0;
  for (const ids of dictGroups.values()) {
    if (ids.length > 1) {
      dictDupeGroups++;
      dictDupeRows += ids.length - 1; // alle utenom én skal slettes
    }
  }

  console.log(`  Duplikat-grupper: ${dictDupeGroups.toLocaleString()}`);
  console.log(`  Rader som ville slettes: ${dictDupeRows.toLocaleString()} (${pct(dictDupeRows, dictTotal)}%)`);

  // Translation memory støy
  console.log("\n─── Translation memory: støy-analyse ───\n");

  let tmAllRows = [];
  offset = 0;
  while (true) {
    const { data, error } = await sb.from("translation_memory")
      .select("id, source_text, target_text")
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    tmAllRows = tmAllRows.concat(data);
    offset += 1000;
    process.stdout.write(`\r  Henter TM... ${tmAllRows.length}/${tmTotal}`);
  }
  process.stdout.write("\n");

  let identical = 0, tinyBoth = 0, numericOnly = 0, empty = 0;
  const flaggedIds = [];

  for (const r of tmAllRows) {
    const s = (r.source_text || "").trim();
    const t = (r.target_text || "").trim();
    if (!s || !t) { empty++; flaggedIds.push(r.id); continue; }
    if (s === t) { identical++; flaggedIds.push(r.id); continue; }
    if (s.length < 5 && t.length < 5) { tinyBoth++; flaggedIds.push(r.id); continue; }
    if (/^[\d\s\-+.,()]+$/.test(s)) { numericOnly++; flaggedIds.push(r.id); continue; }
  }

  console.log(`  Tomme source/target:           ${empty.toLocaleString()}`);
  console.log(`  Identisk source==target:       ${identical.toLocaleString()}`);
  console.log(`  Begge < 5 tegn:                ${tinyBoth.toLocaleString()}`);
  console.log(`  Kun tall/symboler i source:    ${numericOnly.toLocaleString()}`);
  console.log(`  Totalt flagget for sletting:   ${flaggedIds.length.toLocaleString()} (${pct(flaggedIds.length, tmTotal)}%)`);

  // Sanity check
  console.log(`\n─── Sanity check ───`);
  const dictPct = parseFloat(pct(dictDupeRows, dictTotal));
  const tmPct = parseFloat(pct(flaggedIds.length, tmTotal));
  if (dictPct > SANITY_CAP_PCT) {
    console.log(`  🔴 ABORT-flagg: dict-sletting ${dictPct}% > cap ${SANITY_CAP_PCT}%`);
  } else {
    console.log(`  🟢 Dict-sletting ${dictPct}% under cap ${SANITY_CAP_PCT}%`);
  }
  if (tmPct > SANITY_CAP_PCT) {
    console.log(`  🔴 ABORT-flagg: TM-sletting ${tmPct}% > cap ${SANITY_CAP_PCT}%`);
  } else {
    console.log(`  🟢 TM-sletting ${tmPct}% under cap ${SANITY_CAP_PCT}%`);
  }

  console.log(`\n📋 Neste steg hvis ovenstående ser greit ut:`);
  console.log(`   node scripts/cleanup-data.mjs dedupe-dict --execute`);
  console.log(`   node scripts/cleanup-data.mjs clean-tm --execute`);
}

// ─── Fase 3: DEDUPE DICTIONARY ───────────────────────────────────

async function dedupeDict() {
  console.log(`=== FASE 3: DEDUPE DICTIONARY ${dryRun ? "(DRY-RUN)" : "(EXECUTE)"} ===\n`);

  if (!dryRun) {
    const dictBackup = `dictionary_backup_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
    if (!(await tableExists(dictBackup)) && !(await tableExists(dictBackup.replace(/\d{8}$/, "")))) {
      console.log(`  ⚠ Fant ingen backup-tabell. Kjør 'backup' først.`);
      process.exit(1);
    }
  }

  // Hent alle, finn ekte duplikater (identisk på alle 5 kolonner)
  let allRows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb.from("dictionary")
      .select("id, source_lang, target_lang, source_word, target_word, source_pos")
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    allRows = allRows.concat(data);
    offset += 1000;
  }

  const key = (r) => `${r.source_lang}|${r.target_lang}|${r.source_word}|${r.target_word}|${r.source_pos || ""}`;
  const groups = new Map();
  for (const r of allRows) {
    const k = key(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r.id);
  }

  // For hver duplikatgruppe: behold lavest id, slett resten
  const toDelete = [];
  for (const ids of groups.values()) {
    if (ids.length > 1) {
      ids.sort((a, b) => a - b);
      toDelete.push(...ids.slice(1));
    }
  }

  console.log(`Rader å slette: ${toDelete.length.toLocaleString()} (${pct(toDelete.length, allRows.length)}%)`);

  const dictPct = parseFloat(pct(toDelete.length, allRows.length));
  if (dictPct > SANITY_CAP_PCT) {
    console.log(`🔴 ABORT: sletting ${dictPct}% overstiger cap ${SANITY_CAP_PCT}%`);
    process.exit(1);
  }

  if (dryRun) {
    console.log(`\n📋 Dry-run ferdig. Ingen endringer gjort.`);
    console.log(`   For å faktisk slette: node scripts/cleanup-data.mjs dedupe-dict --execute`);
    return;
  }

  console.log(`\n🟡 EXECUTE-mode: sletter ${toDelete.length} rader i batches á ${BATCH_SIZE}...`);
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
    const batch = toDelete.slice(i, i + BATCH_SIZE);
    const { error } = await sb.from("dictionary").delete().in("id", batch);
    if (error) {
      console.error(`  ✗ Batch-feil: ${error.message}`);
      process.exit(1);
    }
    deleted += batch.length;
    process.stdout.write(`\r  Slettet: ${deleted}/${toDelete.length}`);
  }
  process.stdout.write("\n");
  console.log(`✓ Ferdig — ${deleted} duplikat-rader slettet`);
}

// ─── Fase 4: CLEAN TM ──────────────────────────────────────────

async function cleanTM() {
  console.log(`=== FASE 4: CLEAN TRANSLATION MEMORY ${dryRun ? "(DRY-RUN)" : "(EXECUTE)"} ===\n`);

  if (!dryRun) {
    const tmBackup = `translation_memory_backup_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
    if (!(await tableExists(tmBackup))) {
      console.log(`  ⚠ Fant ingen backup-tabell (${tmBackup}). Kjør 'backup' først.`);
      process.exit(1);
    }
  }

  let allRows = [];
  let offset = 0;
  const total = await count("translation_memory");
  while (true) {
    const { data, error } = await sb.from("translation_memory")
      .select("id, source_text, target_text")
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    allRows = allRows.concat(data);
    offset += 1000;
    process.stdout.write(`\r  Henter TM... ${allRows.length}/${total}`);
  }
  process.stdout.write("\n");

  const toDelete = [];
  for (const r of allRows) {
    const s = (r.source_text || "").trim();
    const t = (r.target_text || "").trim();
    if (!s || !t || s === t) { toDelete.push(r.id); continue; }
    if (s.length < 5 && t.length < 5) { toDelete.push(r.id); continue; }
    if (/^[\d\s\-+.,()]+$/.test(s)) { toDelete.push(r.id); continue; }
  }

  console.log(`Rader å slette: ${toDelete.length.toLocaleString()} (${pct(toDelete.length, total)}%)`);

  const tmPct = parseFloat(pct(toDelete.length, total));
  if (tmPct > SANITY_CAP_PCT) {
    console.log(`🔴 ABORT: sletting ${tmPct}% overstiger cap ${SANITY_CAP_PCT}%`);
    process.exit(1);
  }

  if (dryRun) {
    console.log(`\n📋 Dry-run ferdig.`);
    console.log(`   For å faktisk slette: node scripts/cleanup-data.mjs clean-tm --execute`);
    return;
  }

  console.log(`\n🟡 EXECUTE-mode: sletter ${toDelete.length} rader...`);
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
    const batch = toDelete.slice(i, i + BATCH_SIZE);
    const { error } = await sb.from("translation_memory").delete().in("id", batch);
    if (error) {
      console.error(`  ✗ Batch-feil: ${error.message}`);
      process.exit(1);
    }
    deleted += batch.length;
    process.stdout.write(`\r  Slettet: ${deleted}/${toDelete.length}`);
  }
  process.stdout.write("\n");
  console.log(`✓ Ferdig — ${deleted} støy-rader slettet`);
}

// ─── Fase 5: AUDIT ───────────────────────────────────────────────

async function audit() {
  console.log("=== FASE 5: AUDIT-RAPPORT ===\n");
  const dictTotal = await count("dictionary");
  const tmTotal = await count("translation_memory");
  console.log(`Dictionary nå: ${dictTotal.toLocaleString()} rader`);
  console.log(`Translation memory nå: ${tmTotal.toLocaleString()} rader\n`);

  console.log("Stikkprøve på mistenkelige rader (korrupte ord uten mellomrom):");
  const { data: suspicious } = await sb.from("dictionary")
    .select("id, source_lang, target_lang, source_word, target_word")
    .or("target_word.ilike.*ifølge*,target_word.ilike.*iløpetav*,target_word.ilike.*itilleggtil*")
    .limit(20);

  if (suspicious && suspicious.length > 0) {
    for (const r of suspicious) {
      console.log(`  ${r.id} (${r.source_lang}→${r.target_lang}): ${r.source_word} → ${r.target_word}`);
    }
    console.log(`\n📋 Disse er flagget — vurder manuelt om de skal rettes eller slettes.`);
  } else {
    console.log("  Ingen åpenbare korrupte rader funnet.");
  }

  console.log(`\n─── Neste manuelle steg ───`);
  console.log(`1. Verifiser nye totaler ser fornuftige ut`);
  console.log(`2. Test appen — er oversettelseskvaliteten bedre?`);
  console.log(`3. Hvis OK: legg til UNIQUE constraint i Supabase SQL Editor:`);
  console.log(`\n    ALTER TABLE dictionary ADD CONSTRAINT unique_dict_entry`);
  console.log(`      UNIQUE (source_lang, target_lang, source_word, target_word, source_pos);\n`);
  console.log(`   (Hvis dette feiler = det finnes fortsatt duplikater vi missed)`);
}

// ─── Main ──────────────────────────────────────────────────────────

const commands = {
  backup, analyze,
  "dedupe-dict": dedupeDict,
  "clean-tm": cleanTM,
  audit,
};

if (!command || !commands[command]) {
  console.log("Bruk: node scripts/cleanup-data.mjs <command> [--execute]\n");
  console.log("Kommandoer:");
  console.log("  backup        Vis SQL for å lage backup-tabeller (kjør i Supabase Dashboard)");
  console.log("  analyze       Dry-run: vis hva som ville slettes");
  console.log("  dedupe-dict   Slett ekte duplikater i dictionary (krever --execute for å skrive)");
  console.log("  clean-tm      Slett TM-støy (krever --execute for å skrive)");
  console.log("  audit         Etter-rapport, flagger mistenkelige rader");
  process.exit(0);
}

commands[command]().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
