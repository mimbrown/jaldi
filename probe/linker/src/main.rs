//! `probe-linker <entry> <out.js> [--no-minify | --shake-only]`
//! `probe-linker --each <out-dir> <module.js>…` — each module minified alone, the unbundled baseline

use std::time::Instant;

use jaldi_probe_linker::{Mode, bundle, minify_module};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args[0] == "--each" {
        let out = std::path::Path::new(&args[1]);
        for module in &args[2..] {
            let source = std::fs::read_to_string(module).expect("read");
            let name = std::path::Path::new(module).file_name().unwrap();
            std::fs::write(out.join(name), minify_module(&source)).expect("write");
        }
        return;
    }
    let mode = if args.iter().any(|a| a == "--no-minify") {
        Mode::Linked
    } else if args.iter().any(|a| a == "--shake-only") {
        Mode::Shaken
    } else {
        Mode::Minified
    };
    let started = Instant::now();
    let code = bundle(std::path::Path::new(&args[0]), mode);
    let elapsed = started.elapsed();
    std::fs::write(&args[1], &code).expect("write");
    eprintln!("linker: {} bytes, {elapsed:?}", code.len());
}
