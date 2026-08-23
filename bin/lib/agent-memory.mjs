// agent-memory.mjs — the agent-memory tier's extraction boundary.
//
// CPU tier: facts.mjs heuristics, zero LLM. Agent tier: an injected LLM
// caller does open-ended extraction (nuance regexes miss). The LLM is a
// capability supplied at composition time — business logic never constructs
// one inline, and tests inject fakes so nothing here touches a network.
// Output contract matches facts.mjs exactly ({id,title,body,keywords,line}),
// so the reconciler/sink cannot tell the tiers apart.
import { createHash } from "node:crypto";

const MAX_TITLE = 120;
const MAX_FACTS = 40;

const EXTRACTION_PROMPT = [
  "Extract durable user facts from this text.",
  'Return ONLY a JSON array of {title, body, kind}.',
  "kind is one of: preference | assertion | declaration.",
  "No prose, no code fences. Maximum 40 facts.",
].join(" ");

const SECRET_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|Bearer\s+\S+)\b/i;

const factId = (body) =>
  "fact-" + createHash("sha256").update(body).digest("hex").slice(0, 12);

function keywordsFor(kind, body) {
  const words = body.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
  return ["heimdall", "fact", `agent-${kind}`, ...new Set(words)].slice(0, 8);
}

function parseReply(raw) {
  const stripped = String(raw ?? "").replace(/```(?:json)?/g, "");
  const start = stripped.indexOf("[");
  if (start === -1) return [];
  try {
    const parsed = JSON.parse(stripped.slice(start));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** A reply item becomes a fact only if it is clean and secret-free. */
function toFact(item, line) {
  const title = String(item?.title ?? "").trim();
  const body = String(item?.body ?? "").trim();
  const kind = String(item?.kind ?? "assertion");
  if (!title || !body || SECRET_RE.test(title + " " + body)) return null;
  return {
    id: factId(body),
    title: title.slice(0, MAX_TITLE),
    body,
    keywords: keywordsFor(kind, body),
    line,
  };
}

/**
 * agentExtract(buf, meta, {llm}) — agent-tier fact extraction.
 * @param {Buffer} buf file bytes
 * @param {{path: string}} meta source path
 * @param {{llm: (prompt: string) => Promise<string>}} caps injected LLM
 * @returns {Promise<{id,title,body,keywords,line}[]>}
 */
export async function agentExtract(buf, meta = { path: "" }, { llm } = {}) {
  if (!llm) {
    throw new Error(
      'agent tier requires an llm caller; set memory.tier="agent" and wire one');
  }
  const text = buf?.toString("utf8") ?? "";
  if (!text.trim()) return [];
  let reply;
  try {
    reply = await llm(`${EXTRACTION_PROMPT}\n\n${text}`);
  } catch {
    return []; // LLM down ⇒ no facts; CPU tier still covers the file.
  }
  const seen = new Set();
  const out = [];
  for (const item of parseReply(reply).slice(0, MAX_FACTS)) {
    const f = toFact(item, 1);
    if (f && !seen.has(f.title)) { seen.add(f.title); out.push(f); }
  }
  return out;
}
