// people-cli.mjs — `heimdall person …` and the kb_insert --kind person path.
//
// The import shape here is dictated by the REAL knowledge bases on disk
// (2026-09-28 spec, Source knowledge bases), not by the spec's original guess.
// All three carry an identity_verified verdict and a confidence string, and
// many rows are candidly unverified. Those are stored verbatim: dropping them
// would turn a documented unknown into a silent assertion. X rows have neither
// field, so they import as NULL — never as a default value.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PEOPLE_DB, idFor, openPeople, searchPeople, upsertPerson } from "./people.mjs";

const HOME = () => homedir();

export const KB_PATHS = {
  linkedin: () => join(HOME(), "Desktop", "Code Projects", "Connections Enrichment KB"),
  substack: () => join(HOME(), "Desktop", "Documents", "Substack Deva Follower KB"),
  x: () => join(HOME(), "Desktop", "Code Projects", "X DevaBuilds Follower KB"),
  // The user's fourth KB — a personal network built from messages. It has no
  // directory, no dossiers tree and no store anywhere on the volume (searched
  // 2026-09-28: fd for dossiers/ trees, fd for *KB* dirs, content greps for
  // substack/linkedin/last_contact, and every *.db/*.sqlite under $HOME).
  // Listed so the gap is visible rather than silently absent; importing it is
  // a no-op with an explanation, never a silent zero rows.
  personal: () => null,
};

const flagVal = (args, f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

// ── field mapping, one per KB ───────────────────────────────────────────────

// LinkedIn connections. first_name/last_name -> name; company/position ->
// org/role. `slug` is the LinkedIn vanity handle, so it is the alias.
function mapLinkedIn(row) {
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  if (!name) return null;
  return {
    name,
    aliases: row.slug || "",
    org: row.company || "",
    role: row.position || "",
    url: row.linkedin_url || row.linkedin || "",
    notes: [row.interests, row.outreach].filter(Boolean).join("\n").trim(),
    identity_verified: row.identity_verified ?? null,
    confidence: row.confidence ?? null,
    source: "connections-enrichment-kb",
  };
}

// Substack followers. handle -> alias; primary_publication -> org; the profile
// bio is part of the notes, not a separate column.
function mapSubstack(row) {
  const name = (row.name || "").trim();
  if (!name && !row.handle) return null;
  return {
    name: name || row.handle,
    aliases: row.handle || "",
    org: row.primary_publication || "",
    url: row.substack_url || row.publication_url || "",
    notes: [row.bio, row.interests, row.outreach].filter(Boolean).join("\n").trim(),
    identity_verified: row.identity_verified ?? null,
    confidence: row.confidence ?? null,
    source: "substack-deva-follower-kb",
  };
}

// X followers: handle, name, bio. NO identity or confidence field exists, so
// both are left undefined => stored NULL. Absence is a recorded state.
function mapX(row) {
  const handle = (row.handle || "").trim();
  if (!handle) return null;
  return {
    name: (row.name || "").trim() || handle,
    aliases: handle,
    url: `https://x.com/${handle}`,
    notes: row.bio || "",
    identity_verified: null,
    confidence: null,
    source: "x-devabuilds-follower-kb",
  };
}

// Minimal RFC4180 CSV reader. The KB enrichment files are quoted multi-line
// fields with embedded commas and newlines, so a naive split(",") corrupts
// them — a dependency here would be the lazy-but-wrong option.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQ = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() ?? [];
  return rows
    .filter((r) => r.some((v) => v && v.trim()))
    .map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

function readKb(kind) {
  const dir = KB_PATHS[kind]?.();
  if (!dir) {
    return { rows: [], note: `${kind}: no knowledge base on disk (searched 2026-09-28)` };
  }
  if (kind === "x") {
    const p = join(dir, "raw", "x_followers.json");
    if (!existsSync(p)) return { rows: [], note: `${kind}: ${p} missing` };
    return { rows: JSON.parse(readFileSync(p, "utf8")), note: null };
  }
  const p = join(dir, "enrichment.csv");
  if (!existsSync(p)) return { rows: [], note: `${kind}: ${p} missing` };
  return { rows: parseCsv(readFileSync(p, "utf8")), note: null };
}

const MAPPERS = { linkedin: mapLinkedIn, substack: mapSubstack, x: mapX };

export function importKb(store, which, { dryRun = false } = {}) {
  const kinds = which === "all" ? ["linkedin", "substack", "x", "personal"] : [which];
  const report = [];
  for (const k of kinds) {
    const { rows, note } = readKb(k);
    if (note) { report.push({ kb: k, imported: 0, note }); continue; }
    const map = MAPPERS[k];
    let seen = 0, skipped = 0, dupes = 0, refused = 0;
    const ids = new Set();
    for (const row of rows) {
      const p = map(row);
      if (!p) { skipped++; continue; }
      const id = idFor(p.name, p.org);
      if (ids.has(id)) dupes++;
      ids.add(id);
      if (!dryRun) {
        // A refusal must be COUNTED and reported. An earlier version returned
        // silently and lost 9 real people with no trace: 1,519 rows mapped,
        // 1,510 stored, and the report said "skipped: 0".
        const r = upsertPerson(store, p);
        if (r.skipped) { refused++; continue; }
        seen++;
      } else {
        seen++;
      }
    }
    report.push({ kb: k, source_rows: rows.length, stored: seen, skipped,
      refused_by_secret_screen: refused, dupes_in_batch: dupes });
  }
  return report;
}

export async function runPersonCmd(args) {
  const sub = args[0];
  const store = openPeople();
  const get = (f) => flagVal(args, f);
  if (sub === "add" || (sub === undefined && get("--name"))) {
    const name = get("--name");
    if (!name) { console.error('usage: heimdall person add --name "Full Name" [--org O]'); return 1; }
    const r = upsertPerson(store, {
      name, org: get("--org"), role: get("--role"), aliases: get("--aliases"),
      url: get("--url"), notes: get("--notes"), relationship: get("--relationship"),
      last_contact: get("--last-contact"), source: "manual",
    });
    if (r.skipped) { console.error(`refused: ${r.field} looks like a secret`); return 1; }
    console.log(`${r.id}  ${name}`);
    return 0;
  }
  if (sub === "rm") {
    const name = get("--name");
    if (!name) { console.error('usage: heimdall person rm --name "Full Name" [--org O]'); return 1; }
    const id = idFor(name, get("--org"));
    const info = store.db.prepare("DELETE FROM people WHERE id = ?").run(id);
    console.log(info.changes ? `removed ${id}` : `no such person: ${id}`);
    return info.changes ? 0 : 1;
  }
  if (sub === "import") {
    const which = get("--kb") || "all";
    const rep = importKb(store, which, { dryRun: args.includes("--dry-run") });
    for (const r of rep) console.log(JSON.stringify(r));
    return 0;
  }
  if (sub === "list") {
    const limit = Number(get("--limit") || 50);
    for (const r of store.db.prepare("SELECT * FROM people ORDER BY name LIMIT ?").all(limit)) {
      console.log(`${r.id}  ${r.name}${r.org ? "  @ " + r.org : ""}`);
    }
    return 0;
  }
  if (sub === "backup") {
    // P6: people.db is hand-typed user data, so it gets its own snapshot. The
    // precedent is bin/kb-rebuild.sh's sqlite backup, NOT journal.db — the
    // journal has no backup at all (`rg 'journal.db' bin/ | rg -i backup` -> 0).
    const dest = join(HOME(), ".heimdall", "backup");
    mkdirSync(dest, { recursive: true });
    const out = join(dest, `people.db.${new Date().toISOString().replace(/[:.]/g, "-")}`);
    store.db.exec("PRAGMA wal_checkpoint(FULL)");
    copyFileSync(PEOPLE_DB(), out);
    console.log(`people.db backed up -> ${out}`);
    return 0;
  }
  console.error("usage: heimdall person <add|rm|import|list|backup> ...");
  return 1;
}

// The kb_insert --kind person path: an agent-facing alias for person add.
export function runPersonInsert(args) {
  const get = (f) => flagVal(args, f);
  const name = get("--name") || get("--title");
  if (!name) {
    console.error('usage: heimdall insert --kind person --name "Full Name" [--org O]');
    return 1;
  }
  const store = openPeople();
  const r = upsertPerson(store, {
    name, org: get("--org"), role: get("--role"), aliases: get("--aliases"),
    url: get("--url"), notes: get("--notes"), source: "manual",
  });
  if (r.skipped) { console.error(`refused: ${r.field} looks like a secret`); return 1; }
  console.log(`${r.id}  ${name}`);
  return 0;
}
