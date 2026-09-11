use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};

pub fn default_db() -> PathBuf {
    std::env::var("HEIMDALL_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs_home().join(".heimdall/global.db"))
}

pub fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

pub const VEC0: &str = "/Users/arihantdeva/.heimdall/venv/lib/python3.12/site-packages/sqlite_vec/vec0.dylib";

#[derive(Debug)]
pub struct Hit {
    pub path: String,
    pub title: String,
    pub score: f64,
}

fn open(db: &Path) -> Result<Connection, Box<dyn std::error::Error>> {
    let conn = Connection::open(db)?;
    unsafe {
        conn.load_extension_enable()?;
    }
    let _ = unsafe { conn.load_extension(VEC0, None) };
    conn.load_extension_disable()?;
    Ok(conn)
}

/// Lexical search over cards: FTS5 if present, else LIKE fallback.
pub fn search(db: &Path, query: &str, k: usize) -> Result<Vec<Hit>, Box<dyn std::error::Error>> {
    let conn = open(db)?;
    let has_fts = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cards_fts'")?
        .exists([])?;

    let mut out = Vec::new();
    if has_fts {
        let q = format!("\"{}\"", query.replace('"', " "));
        let mut stmt = conn.prepare(
            "SELECT path, title, bm25(cards_fts) FROM cards_fts
             WHERE cards_fts MATCH ?1 ORDER BY bm25(cards_fts) LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![q, k as i64], |r| {
            Ok(Hit { path: r.get(0)?, title: r.get(1)?, score: r.get(2)? })
        })?;
        for row in rows {
            out.push(row?);
        }
    } else {
        let like = format!("%{}%", query);
        let mut stmt = conn.prepare(
            "SELECT path, title, 0.0 FROM cards WHERE title LIKE ?1 OR body LIKE ?1 LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![like, k as i64], |r| {
            Ok(Hit { path: r.get(0)?, title: r.get(1)?, score: r.get(2)? })
        })?;
        for row in rows {
            out.push(row?);
        }
    }
    Ok(out)
}

/// Vector search: embed query, run vec_top_k, join to cards.
pub fn search_vec(
    db: &Path,
    embedder: &mut heimdall_embed::Embedder,
    query: &str,
    k: usize,
) -> Result<Vec<Hit>, Box<dyn std::error::Error>> {
    let conn = open(db)?;
    let vec = embedder.encode(query)?;
    let blob: Vec<u8> = vec.iter().flat_map(|x| x.to_le_bytes()).collect();
    let mut stmt = conn.prepare(
        "SELECT c.path, c.title, v.distance FROM vec v
         JOIN cards c ON c.rowid = v.rowid
         WHERE v.embedding MATCH ?1 AND k = ?2 ORDER BY v.distance LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![blob, k as i64], |r| {
        Ok(Hit { path: r.get(0)?, title: r.get(1)?, score: r.get::<_, Option<f64>>(2)?.unwrap_or(0.0) })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Reciprocal-rank fusion (zvec-grep port, P4): score = Σ 1/(RRF_K + rank)
/// per source. Raw scores are ignored — rank order is all that matters, which
/// makes BM25 magnitudes and cosine distances comparable for free.
pub const RRF_K: f64 = 60.0;

pub fn fuse_rrf(lex: &[Hit], vec: &[Hit], _k: usize) -> Vec<Hit> {
    let mut best: std::collections::HashMap<String, (f64, String)> = std::collections::HashMap::new();
    // Fuse over the FULL recall width, cap afterwards: a hit at rank k+1 in
    // BOTH sources (2/(RRF_K+k+1)) outranks a single rank-k hit (1/(RRF_K+k))
    // and must not be cut before fusion.
    for (src_rank, source) in [(0usize, lex), (1usize, vec)] {
        for (i, hit) in source.iter().enumerate() {
            let e = best.entry(hit.path.clone()).or_insert((0.0, hit.title.clone()));
            e.0 += 1.0 / (RRF_K + (i + 1) as f64);
            if src_rank == 1 && i == 0 && hit.title.len() > e.1.len() {
                e.1 = hit.title.clone();
            }
        }
    }
    let mut out: Vec<Hit> = best
        .into_iter()
        .map(|(path, (score, title))| Hit { path, title, score })
        .collect();
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// Adaptive recall ladder (zvec-grep port, P4): next recall width, doubling
/// until the cap. Callers stop when the fused top-k stops changing.
pub fn next_recall(current: usize, cap: usize) -> usize {
    (current.saturating_mul(2)).min(cap.max(1))
}

/// Hybrid route: lexical + vector recall, fused with RRF. Recall grows
/// adaptively (200 → 400 → … → cap 2000) until the top-k stabilizes.
pub fn search_hybrid(
    db: &Path,
    embedder: &mut heimdall_embed::Embedder,
    query: &str,
    k: usize,
) -> Result<Vec<Hit>, Box<dyn std::error::Error>> {
    const START: usize = 200;
    const CAP: usize = 2000;
    let mut width = START.min(CAP);
    let mut prev_top: Option<Vec<String>> = None;
    loop {
        let lex = search(db, query, width)?;
        let vec = search_vec(db, embedder, query, width)?;
        let fused = fuse_rrf(&lex, &vec, k);
        let top: Vec<String> = fused.iter().take(k).map(|h| h.path.clone()).collect();
        if width >= CAP || prev_top.as_deref() == Some(top.as_slice()) {
            return Ok(fused.into_iter().take(k).collect());
        }
        prev_top = Some(top);
        width = next_recall(width, CAP);
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let db = default_db();
    if args.len() < 2 {
        eprintln!("usage: heimdall-search <query> [k] | --vec <query> [k] | --hybrid <query> [k]");
        std::process::exit(2);
    }
    if args[1] == "--hybrid" {
        let q = args.get(2).ok_or("usage: heimdall-search --hybrid <query> [k]")?;
        let k: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(10);
        let mut emb = heimdall_embed::Embedder::new(Path::new(heimdall_embed::MODEL_DIR))?;
        for hit in search_hybrid(&db, &mut emb, q, k)? {
            println!("{:.3}\t{}\t{}", hit.score, hit.path, hit.title);
        }
        return Ok(());
    }
    let query = &args[1];
    let k: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(10);
    if args[1] == "--vec" {
        let q = args.get(2).ok_or("usage: heimdall-search --vec <query> [k]")?;
        let k: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(10);
        let mut emb = heimdall_embed::Embedder::new(Path::new(heimdall_embed::MODEL_DIR))?;
        for hit in search_vec(&db, &mut emb, q, k)? {
            println!("{:.3}\t{}\t{}", hit.score, hit.path, hit.title);
        }
        return Ok(());
    }
    for hit in search(&db, query, k)? {
        println!("{:.3}\t{}\t{}", hit.score, hit.path, hit.title);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_returns_hits() {
        let hits = search(default_db().as_path(), "rust", 10).expect("search ok");
        assert!(!hits.is_empty(), "expected hits for 'rust'");
        assert!(hits.iter().all(|h| !h.path.is_empty()));
    }

    #[test]
    fn rrf_prefers_multi_source_hits() {
        // zg port (P4): Σ 1/(k + rank) fusion. A hit recalled by BOTH lexical
        // and vector sources must outrank a hit found by only one source,
        // regardless of raw scores.
        let lex = vec![
            Hit { path: "a.rs".into(), title: "a".into(), score: 5.0 },
            Hit { path: "b.rs".into(), title: "b".into(), score: 4.0 },
        ];
        let vec = vec![
            Hit { path: "b.rs".into(), title: "b".into(), score: 0.9 },
            Hit { path: "c.rs".into(), title: "c".into(), score: 0.8 },
        ];
        let fused = fuse_rrf(&lex, &vec, 10);
        assert_eq!(fused[0].path, "b.rs", "dual-source hit wins");
        let a = fused.iter().find(|h| h.path == "a.rs").unwrap();
        let c = fused.iter().find(|h| h.path == "c.rs").unwrap();
        assert!(a.score > c.score, "rank-1 single-source beats rank-2 single-source");
    }

    #[test]
    fn recall_growth_respects_cap() {
        // zg port (P4): adaptive recall — start small, double until the fused
        // top-k stabilizes or the cap is reached.
        assert_eq!(next_recall(200, 2000), 400);
        assert_eq!(next_recall(1600, 2000), 2000);
        assert_eq!(next_recall(2000, 2000), 2000);
    }

    #[test]
    fn rrf_fuses_full_width_before_capping() {
        // Regression: a hit at rank k+1 in BOTH sources outranks a single
        // rank-1 hit and must survive fusion even when k=1.
        let lex = vec![
            Hit { path: "a.rs".into(), title: "a".into(), score: 9.0 },
            Hit { path: "b.rs".into(), title: "b".into(), score: 8.0 },
        ];
        let vec = vec![
            Hit { path: "z.rs".into(), title: "z".into(), score: 0.99 },
            Hit { path: "b.rs".into(), title: "b".into(), score: 0.98 },
        ];
        let fused = fuse_rrf(&lex, &vec, 1);
        assert_eq!(fused[0].path, "b.rs", "dual-source rank-2 beats single-source rank-1");
    }
}