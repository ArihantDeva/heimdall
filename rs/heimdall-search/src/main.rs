use std::path::Path;

use rusqlite::{params, Connection};

pub const DB: &str = "/Users/arihantdeva/.heimdall/global.db";
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: heimdall-search <query> [k]");
        std::process::exit(2);
    }
    let query = &args[1];
    let k: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(10);
    if args.len() >= 2 && args[1] == "--vec" {
        let q = args.get(2).ok_or("usage: heimdall-search --vec <query> [k]")?;
        let k: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(10);
        let mut emb = heimdall_embed::Embedder::new(Path::new(heimdall_embed::MODEL_DIR))?;
        for hit in search_vec(Path::new(DB), &mut emb, q, k)? {
            println!("{:.3}\t{}\t{}", hit.score, hit.path, hit.title);
        }
        return Ok(());
    }
    for hit in search(Path::new(DB), query, k)? {
        println!("{:.3}\t{}\t{}", hit.score, hit.path, hit.title);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_returns_hits() {
        let hits = search(Path::new(DB), "rust", 10).expect("search ok");
        assert!(!hits.is_empty(), "expected hits for 'rust'");
        assert!(hits.iter().all(|h| !h.path.is_empty()));
    }
}