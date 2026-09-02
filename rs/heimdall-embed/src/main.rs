use std::path::Path;

use heimdall_embed::Embedder;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: heimdall-embed <text> [more...]");
        std::process::exit(2);
    }
    let model_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("model");
    let mut e = Embedder::new(&model_dir)?;
    for t in &args[1..] {
        let v = e.encode(t)?;
        println!("{}", v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","));
    }
    Ok(())
}