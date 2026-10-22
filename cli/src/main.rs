//! `jaldi`: lowers a framework's frontend behind the contract in
//! `jaldi-contract`.
//!
//! ```text
//! jaldi version              the tool's and the contract's versions
//! jaldi lower <manifest>     read a manifest (a path, or `-` for stdin),
//!                            write the outputs and the answer
//! ```

mod check;
mod erase;
mod sheet;

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use jaldi_contract::{
    Answer, CONTRACT, Diagnostic, Entry, EntryId, Hash, Kind, Manifest, Output, Position, Produced, Severity, Text, exit,
};
use sha2::{Digest, Sha256};

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
            broken()
        }
    }
}

fn broken() -> ExitCode {
    ExitCode::from(exit::BROKEN as u8)
}

fn lower(path: &str) -> ExitCode {
    let json = match read(path) {
        Ok(json) => json,
        Err(e) => {
            eprintln!("jaldi: cannot read the manifest {path}: {e}");
            return broken();
        }
    };
    // The version first, alone: a manifest from another contract is
    // refused by name, never misparsed into a field error.
    let version = match jaldi_contract::manifest_version(&json) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("jaldi: the manifest does not lead with a contract version: {e}");
            return broken();
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
            return broken();
        }
    };
    let answer = match run(&manifest) {
        Ok(output) => Answer::Produced(output),
        Err(e) => {
            eprintln!("jaldi: {e}");
            return broken();
        }
    };
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

fn hash(bytes: &[u8]) -> Hash {
    input_hash(&[bytes])
}

/// Everything the run writes and says. An error here is the run itself
/// failing (an output directory that cannot be made, a record that
/// cannot be written): the caller exits `BROKEN`. A problem with an
/// entry is a diagnostic, and that entry produces nothing.
fn run(manifest: &Manifest) -> Result<Output, String> {
    let root = &manifest.root;
    if !root.is_absolute() {
        return Err(format!("the manifest's root is not absolute: {}", root.display()));
    }
    let out_dir = root.join(&manifest.out_dir);
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("cannot create {}: {e}", out_dir.display()))?;

    let mut diagnostics = Vec::new();
    let mut produced = Vec::new();
    let mut seen: HashSet<&EntryId> = HashSet::new();
    let mut enhancements: Vec<(&Entry, PathBuf, PathBuf, String, String)> = Vec::new();
    let mut sheets: Vec<(&Entry, String, String, &[String])> = Vec::new();

    for entry in &manifest.entries {
        if let Some(problem) = entry.id.problem() {
            diagnostics.push(error(entry, None, format!("the entry id `{}` {problem}", entry.id)));
            continue;
        }
        if !seen.insert(&entry.id) {
            diagnostics.push(error(
                entry,
                None,
                format!("the entry id `{}` is used twice in this manifest", entry.id),
            ));
            continue;
        }
        match &entry.kind {
            Kind::Enhancement { source, header } => {
                let source_path = root.join(source);
                let header_path = root.join(header);
                let text = match std::fs::read_to_string(&source_path) {
                    Ok(t) => t,
                    Err(e) => {
                        diagnostics.push(error(entry, None, format!("cannot read the source {}: {e}", source.display())));
                        continue;
                    }
                };
                let header_text = match std::fs::read_to_string(&header_path) {
                    Ok(t) => t,
                    Err(e) => {
                        diagnostics.push(error(entry, None, format!("cannot read the header {}: {e}", header.display())));
                        continue;
                    }
                };
                enhancements.push((entry, source_path, header_path, text, header_text));
            }
            Kind::Sheet { source, tokens } => {
                let (name, text) = match source {
                    Text::File { path } => match std::fs::read_to_string(root.join(path)) {
                        Ok(t) => (path.display().to_string(), t),
                        Err(e) => {
                            diagnostics.push(error(entry, None, format!("cannot read the sheet {}: {e}", path.display())));
                            continue;
                        }
                    },
                    Text::Inline { content } => (format!("{}.css", entry.id), content.clone()),
                };
                sheets.push((entry, name, text, tokens));
            }
        }
    }

    // The check, one program over every enhancement: the module against
    // its header, its default export against the header's `Mount`.
    let mut failed: HashSet<EntryId> = HashSet::new();
    if !enhancements.is_empty() {
        let checked: Vec<check::Checked> = enhancements
            .iter()
            .map(|(entry, source, header, _, _)| check::Checked {
                id: entry.id.clone(),
                origin: entry.origin.clone(),
                source: source.clone(),
                header: header.clone(),
            })
            .collect();
        for d in check::run(&checked) {
            if d.severity == Severity::Error
                && let Some(id) = &d.entry
            {
                failed.insert(id.clone());
            }
            diagnostics.push(d);
        }
    }

    for (entry, source_path, _, text, header_text) in &enhancements {
        if failed.contains(&entry.id) {
            continue;
        }
        let name = source_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let erased = match erase::erase(text, &name, manifest.source_maps) {
            Ok(e) => e,
            Err(problems) => {
                diagnostics.extend(problems.into_iter().map(|(at, message)| error(entry, at, message)));
                continue;
            }
        };
        let record = write(
            &out_dir,
            entry,
            "js",
            erased.code.as_bytes(),
            erased.map.as_deref(),
            hash(text.as_bytes()),
            None,
        )?;
        produced.push(record);
    }

    for (entry, name, text, tokens) in &sheets {
        let lowered = match sheet::lower(text, name, manifest.browsers, tokens, manifest.source_maps) {
            Ok(l) => l,
            Err((at, message)) => {
                diagnostics.push(error(entry, at, message));
                continue;
            }
        };
        let mut errors = false;
        for (at, message) in lowered.problems {
            errors = true;
            diagnostics.push(error(entry, at, message));
        }
        if errors {
            continue;
        }
        let record = write(
            &out_dir,
            entry,
            "css",
            lowered.css.as_bytes(),
            lowered.map.as_deref(),
            hash(text.as_bytes()),
            Some(lowered.facts),
        )?;
        produced.push(record);
    }

    Ok(Output {
        contract: CONTRACT,
        tool: TOOL.into(),
        produced,
        diagnostics,
    })
}

fn error(entry: &Entry, at: Option<Position>, message: String) -> Diagnostic {
    Diagnostic {
        entry: Some(entry.id.clone()),
        severity: Severity::Error,
        message,
        at,
        origin: Some(entry.origin.clone()),
    }
}

/// Write an entry's output, its map, and its record.
fn write(
    out_dir: &Path,
    entry: &Entry,
    extension: &str,
    output: &[u8],
    map: Option<&str>,
    input_hash: Hash,
    sheet: Option<jaldi_contract::SheetFacts>,
) -> Result<Produced, String> {
    let put = |name: &str, bytes: &[u8]| -> Result<(), String> {
        let path = out_dir.join(name);
        std::fs::write(&path, bytes).map_err(|e| format!("cannot write {}: {e}", path.display()))
    };
    let output_name = format!("{}.{extension}", entry.id);
    put(&output_name, output)?;
    let source_map = match map {
        Some(map) => {
            let name = format!("{output_name}.map");
            put(&name, map.as_bytes())?;
            Some(PathBuf::from(name))
        }
        None => None,
    };
    let record = Produced {
        id: entry.id.clone(),
        input_hash,
        output: PathBuf::from(&output_name),
        output_hash: hash(output),
        source_map,
        sheet,
    };
    put(&format!("{}.json", entry.id), record.to_json().as_bytes())?;
    Ok(record)
}
