//! `jaldi`: lowers a framework's frontend behind the contract in
//! `jaldi-contract`. This version knows the contract and the refusal and
//! lowers nothing yet; each kind arrives in its own release.
//!
//! ```text
//! jaldi version              the tool's and the contract's versions
//! jaldi lower <manifest>     read a manifest (a path, or `-` for stdin),
//!                            write the answer to stdout
//! ```

use std::io::Read;
use std::process::ExitCode;

use jaldi_contract::{Answer, CONTRACT, Diagnostic, Kind, Manifest, Output, Severity, exit};

const TOOL: &str = concat!("jaldi ", env!("CARGO_PKG_VERSION"));

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["version"] => {
            println!("{TOOL}\ncontract {CONTRACT}");
            ExitCode::SUCCESS
        }
        ["lower", manifest] => lower(manifest),
        _ => {
            eprintln!("usage:\n  jaldi version\n  jaldi lower <manifest.json | ->");
            ExitCode::from(exit::BROKEN as u8)
        }
    }
}

fn lower(path: &str) -> ExitCode {
    let json = match read(path) {
        Ok(json) => json,
        Err(e) => {
            eprintln!("jaldi: cannot read the manifest {path}: {e}");
            return ExitCode::from(exit::BROKEN as u8);
        }
    };
    // The version first, alone: a manifest from another contract is
    // refused by name, never misparsed into a field error.
    let version = match jaldi_contract::manifest_version(&json) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("jaldi: the manifest does not lead with a contract version: {e}");
            return ExitCode::from(exit::BROKEN as u8);
        }
    };
    if version != CONTRACT {
        let answer = Answer::Refused {
            contract: CONTRACT,
            manifest: version,
            tool: TOOL.into(),
        };
        eprintln!("jaldi: refused — the manifest is written against contract {version}, {TOOL} speaks contract {CONTRACT}");
        println!("{}", answer.to_json());
        return ExitCode::from(answer.exit_status() as u8);
    }
    let manifest = match Manifest::from_json(&json) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("jaldi: the manifest does not parse as contract {CONTRACT}: {e}");
            return ExitCode::from(exit::BROKEN as u8);
        }
    };
    let answer = Answer::Produced(run(&manifest));
    println!("{}", answer.to_json());
    ExitCode::from(answer.exit_status() as u8)
}

fn read(path: &str) -> std::io::Result<String> {
    if path == "-" {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s)?;
        Ok(s)
    } else {
        std::fs::read_to_string(path)
    }
}

/// The run. No kind is lowered yet: every entry comes back as an error
/// naming what this version does not do, so the framework's build sees a
/// refusal per entry rather than a silent nothing.
fn run(manifest: &Manifest) -> Output {
    let diagnostics = manifest
        .entries
        .iter()
        .map(|entry| {
            let kind = match &entry.kind {
                Kind::Enhancement { .. } => "an enhancement",
                Kind::Script { .. } => "a script",
                Kind::Sheet { .. } => "a sheet",
            };
            Diagnostic {
                entry: Some(entry.id.clone()),
                severity: Severity::Error,
                message: format!("{TOOL} does not lower {kind} yet"),
                at: None,
                origin: Some(entry.origin.clone()),
            }
        })
        .collect();
    Output {
        contract: CONTRACT,
        tool: TOOL.into(),
        produced: vec![],
        diagnostics,
    }
}
