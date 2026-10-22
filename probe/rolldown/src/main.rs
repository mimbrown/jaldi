//! `probe-rolldown <entry> <out.js> [--no-minify | --shake-only]`

use std::time::Instant;

use jaldi_probe_rolldown::{Mode, bundle};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = if args.iter().any(|a| a == "--no-minify") {
        Mode::Linked
    } else if args.iter().any(|a| a == "--shake-only") {
        Mode::Shaken
    } else {
        Mode::Minified
    };
    let started = Instant::now();
    let code = match bundle(std::path::Path::new(&args[0]), mode) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    };
    let elapsed = started.elapsed();
    std::fs::write(&args[1], &code).expect("write");
    eprintln!("rolldown: {} bytes, {elapsed:?}", code.len());
}
