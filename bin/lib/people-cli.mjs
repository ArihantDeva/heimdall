// people-cli.mjs — `heimdall person …` and the kb_insert --kind person path.
//
// The import shape here is dictated by the REAL knowledge bases on disk
// (2026-09-28 spec, Source knowledge bases), not by the spec's original guess.
// All three carry an identity_verified verdict and a confidence string, and
// many rows are candidly unverified. Those are stored verbatim: dropping them
// would turn a documented unknown into a silent assertion. X rows have neither
// field, so they import as NULL — never as a default value.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { PEOPLE_DB, idFor, openPeople, screenPerson, upsertPerson } from "./people.mjs";

// A WAL-consistent snapshot. Node's backup() yields a progress callback that
// must be invoked for the copy to run, hence the loop rather than a bare call.
async function backup(src, dest) {
  const from = new DatabaseSync(src, { readOnly: true });
  try {
    await sqliteBackup(from, dest, {
      progress: () => true,
    });
    return existsSync(dest);
  } finally {
    from.close();
  }
}

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
// "absent in the source" must be null, never "". The upsert's
// COALESCE(excluded.col, col) guard only preserves a stored value when the
// incoming value is NULL; '' is not NULL, so the guard silently does not fire
// and a routine re-import destroys hand-typed data. Measured on the real X KB:
// crescely's hand-typed notes were wiped to '' by an ordinary re-import, and
// no source KB carries notes, so nothing could ever restore them.
//
// Deliberately NOT fixed in SQL as COALESCE(NULLIF(excluded.notes,''), notes):
// that would make the only way to CLEAR a field -- passing --notes "" --
// permanently impossible. The distinction matters: null means "the source has
// no value, keep what you have", '' means "actually clear this".
const absent = (v) => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};
const absentNotes = (...parts) => absent(parts.filter(Boolean).join("\n").trim());

// org/role. `slug` is the LinkedIn vanity handle, so it is the alias.
function mapLinkedIn(row) {
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  if (!name) return null;
  return {
    name,
    aliases: absent(row.slug),
    org: absent(row.company),
    role: absent(row.position),
    url: absent(row.linkedin_url || row.linkedin),
    notes: absentNotes(row.interests, row.outreach),
    identity_verified: absent(row.identity_verified),
    confidence: absent(row.confidence),
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
    aliases: absent(row.handle),
    org: absent(row.primary_publication),
    url: absent(row.substack_url || row.publication_url),
    notes: absentNotes(row.bio, row.interests, row.outreach),
    identity_verified: absent(row.identity_verified),
    confidence: absent(row.confidence),
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
    notes: absent(row.bio),
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
      // The screen runs in DRY-RUN too, and that is the whole point: the
      // previous version skipped it, so `--dry-run` reported
      // stored=1519/refused=0 where the real run stored 1510 and refused 9.
      // A dry run that cannot see the refusals is worse than no dry run --
      // it is the number the user decides to commit on.
      const would = screenPerson(p);
      if (would) { refused++; continue; }
      seen++;
      if (!dryRun) upsertPerson(store, p);
    }
    report.push({ kb: k, source_rows: rows.length, stored: seen, skipped,
      refused_by_secret_screen: refused, dupes_in_batch: dupes });
  }
  return report;
}

export async function runPersonCmd(args) {
  const sub = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  const FLAGS = {
    add: ["--name", "--org", "--role", "--aliases", "--url", "--notes",
      "--relationship", "--last-contact", "--source"],
    rm: ["--name", "--org"],
    import: ["--kb", "--dry-run"],
    list: ["--limit"],
    backup: [],
  };
  const allowed = FLAGS[sub];
  if (allowed) {
    const bad = args.filter((a) => a.startsWith("--") && !allowed.includes(a));
    if (bad.length) {
      for (const b of bad) console.error(`unknown option for person ${sub}: ${b}`);
      return 2;
    }
  }
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
    // Exit 2 on an unknown KB, like kb-search.sh:74-81 does for an unknown
    // --kind. Previously `person import --kb bogus` exited 0 with a note
    // indistinguishable from the genuinely absent personal KB -- the exact
    // silent-success defect checkFlags exists to prevent.
    const valid = ["all", ...Object.keys(KB_PATHS)];
    if (!valid.includes(which)) {
      console.error(`unknown --kb '${which}' (valid: ${valid.join(", ")})`);
      return 2;
    }
    const rep = importKb(store, which, { dryRun: args.includes("--dry-run") });
    let refused = 0;
    for (const r of rep) {
      refused += r.refused_by_secret_screen || 0;
      console.log(JSON.stringify(r));
    }
    if (refused) console.error(`${refused} row(s) refused by the secret screen and NOT stored`);
    return 0;
  }
  if (sub === "list") {
    const raw = get("--limit") || 50;
    const limit = Number(raw);
    if (!Number.isInteger(limit) || limit < 1) {
      console.error(`--limit must be a positive integer, got '${raw}'`);
      return 2;
    }
    for (const r of store.db.prepare("SELECT * FROM people ORDER BY name LIMIT ?").all(limit)) {
      console.log(`${r.id}  ${r.name}${r.org ? "  @ " + r.org : ""}`);
    }
    return 0;
  }
  if (sub === "backup") {
    // P6: people.db is hand-typed user data, so it gets its own snapshot.
    //
    // The sqlite BACKUP API, not copyFileSync. The previous version did
    // `PRAGMA wal_checkpoint(FULL)` (whose busy=1 result was never checked)
    // and then copied the main db without its WAL. Proven 3/3 corrupt --
    // "database disk image is malformed" -- under a concurrent reader, and
    // it can also tear SILENTLY: exit 0, integrity_check ok, one row gone.
    // PRAGMA wal_checkpoint(FULL) cannot checkpoint frames younger than the
    // oldest live reader, so it is the wrong tool by construction.
    //
    // Same pattern, and for the same reason, as bin/kb-rebuild.sh:23-31.
    const dest = join(HOME(), ".heimdall", "backup");
    mkdirSync(dest, { recursive: true });
    const out = join(dest, `people.db.${new Date().toISOString().replace(/[:.]/g, "-")}`);
    const done = await backup(PEOPLE_DB(), out);
    if (!done) { console.error(`backup failed: ${out}`); return 1; }
    const rows = store.db.prepare("SELECT count(*) n FROM people").get().n;
    console.log(`people.db backed up -> ${out} (${rows} rows)`);
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
