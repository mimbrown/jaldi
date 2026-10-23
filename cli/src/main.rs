//! `jaldi`: lowers a framework's frontend behind the contract in
//! `jaldi-contract`.
//!
//! ```text
//! jaldi version              the tool's and the contract's versions
//! jaldi lower <manifest>     read a manifest (a path, or `-` for stdin),
//!                            write the outputs and the answer
//! ```

mod bundle;
mod check;
mod erase;
mod imports;
mod sheet;

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use jaldi_contract::{
    Answer, BundleFacts, CONTRACT, Diagnostic, Entry, EntryId, Hash, Kind, Manifest, Output, Position, Produced, Severity, Text, exit,
    input_hash,
};

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
    let mut modules: Vec<(&Entry, PathBuf, String)> = Vec::new();
    let mut declarations: Vec<(&Entry, PathBuf, String)> = Vec::new();
    let mut sheets: Vec<(&Entry, String, String, &[String])> = Vec::new();
    let mut bundles: Vec<Bundle> = Vec::new();

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
            Kind::Module { source } | Kind::Declarations { source } => {
                let path = root.join(source);
                let text = match std::fs::read_to_string(&path) {
                    Ok(t) => t,
                    Err(e) => {
                        diagnostics.push(error(entry, None, format!("cannot read the source {}: {e}", source.display())));
                        continue;
                    }
                };
                if matches!(entry.kind, Kind::Module { .. }) {
                    modules.push((entry, path, text));
                } else {
                    declarations.push((entry, path, text));
                }
            }
            Kind::Bundle { entry: text, modules } => {
                if let Some(bundle) = read_bundle(root, entry, text, modules, &mut diagnostics) {
                    bundles.push(bundle);
                }
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

    // The check, one program over every enhancement, module and
    // declaration file: an enhancement against its header, its default
    // export against the header's `Mount`; a module against the modules
    // it imports.
    let mut failed: HashSet<EntryId> = HashSet::new();
    if !enhancements.is_empty() || !modules.is_empty() || !declarations.is_empty() || !bundles.is_empty() {
        let checked: Vec<check::Checked> = enhancements
            .iter()
            .map(|(entry, source, header, _, _)| check::Checked {
                id: entry.id.clone(),
                origin: entry.origin.clone(),
                source: source.clone(),
                header: Some(header.clone()),
            })
            .chain(modules.iter().chain(&declarations).map(|(entry, source, _)| check::Checked {
                id: entry.id.clone(),
                origin: entry.origin.clone(),
                source: source.clone(),
                header: None,
            }))
            .collect();
        let bundled: Vec<check::Bundle> = bundles
            .iter()
            .map(|b| check::Bundle {
                id: b.entry.id.clone(),
                origin: b.entry.origin.clone(),
                entry: b.text.clone(),
                modules: b
                    .modules
                    .iter()
                    .map(|m| (m.id.clone(), m.path.clone(), m.relative.clone(), imports::has_default(&m.text)))
                    .collect(),
            })
            .collect();
        for d in check::run(&checked, &bundled) {
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
            input_hash(&[text.as_bytes(), header_text.as_bytes()]),
            None,
            None,
        )?;
        produced.push(record);
    }

    // The modules: their imports held to the output layout, then erased
    // together. One program, so one outcome: an error in any module (or
    // in a declaration file they are checked against, or a failure of the
    // run itself) writes none of them.
    let declared: HashSet<String> = declarations.iter().flat_map(|(_, _, text)| imports::declared(text)).collect();
    if !modules.is_empty() {
        let program: Vec<imports::Module> = modules
            .iter()
            .map(|(entry, source, text)| imports::Module {
                id: &entry.id,
                source,
                text,
            })
            .collect();
        for (i, (entry, _, _)) in modules.iter().enumerate() {
            for (at, message) in imports::check(root, &program, i, &declared) {
                failed.insert(entry.id.clone());
                diagnostics.push(error(entry, Some(at), message));
            }
        }
        let mut erased = Vec::new();
        for (entry, source_path, text) in &modules {
            if failed.contains(&entry.id) {
                continue;
            }
            let name = source_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            match erase::erase(text, &name, manifest.source_maps) {
                Ok(e) => erased.push((entry, text, e)),
                Err(problems) => {
                    failed.insert(entry.id.clone());
                    diagnostics.extend(problems.into_iter().map(|(at, message)| error(entry, at, message)));
                }
            }
        }
        let run_failed = diagnostics.iter().any(|d| d.severity == Severity::Error && d.entry.is_none());
        let set_failed = run_failed || modules.iter().chain(&declarations).any(|(entry, _, _)| failed.contains(&entry.id));
        if !set_failed {
            for (entry, text, erased) in erased {
                let record = write(
                    &out_dir,
                    entry,
                    "js",
                    erased.code.as_bytes(),
                    erased.map.as_deref(),
                    hash(text.as_bytes()),
                    None,
                    None,
                )?;
                produced.push(record);
            }
        }
    }

    // The bundles: each module held to the output layout, as a module is;
    // then linked from the entry. A bundle with an error anywhere in its
    // program writes nothing, and nothing is written on a run that failed.
    for bundle in &bundles {
        let entry = bundle.entry;
        let program: Vec<imports::Module> = bundle
            .modules
            .iter()
            .map(|m| imports::Module {
                id: &m.id,
                source: &m.path,
                text: &m.text,
            })
            .collect();
        let ids: Vec<&EntryId> = bundle.modules.iter().map(|m| &m.id).collect();
        for (at, message) in imports::check_entry(&bundle.text, &ids, &declared) {
            failed.insert(entry.id.clone());
            diagnostics.push(error(entry, Some(at), message));
        }
        for (i, m) in bundle.modules.iter().enumerate() {
            for (at, message) in imports::check(root, &program, i, &declared) {
                failed.insert(entry.id.clone());
                diagnostics.push(error(entry, None, in_module(m, Some(at), &message)));
            }
        }
        let run_failed = diagnostics.iter().any(|d| d.severity == Severity::Error && d.entry.is_none());
        let declarations_failed = declarations.iter().any(|(entry, _, _)| failed.contains(&entry.id));
        if run_failed || declarations_failed || failed.contains(&entry.id) {
            continue;
        }
        let input = bundle::Input {
            entry: bundle::File {
                id: &entry.id,
                name: bundle.name.clone(),
                text: &bundle.text,
            },
            modules: bundle
                .modules
                .iter()
                .map(|m| bundle::File {
                    id: &m.id,
                    name: m.relative.clone(),
                    text: &m.text,
                })
                .collect(),
            declared: &declared,
            source_map: manifest.source_maps,
        };
        match bundle::bundle(&input) {
            Ok(linked) => {
                let mut inputs: Vec<&[u8]> = vec![bundle.text.as_bytes()];
                inputs.extend(bundle.modules.iter().map(|m| m.text.as_bytes()));
                let record = write(
                    &out_dir,
                    entry,
                    "js",
                    linked.code.as_bytes(),
                    linked.map.as_deref(),
                    input_hash(&inputs),
                    None,
                    Some(linked.facts),
                )?;
                produced.push(record);
            }
            Err(problems) => {
                for p in problems {
                    let d = match p.file {
                        None => error(entry, p.at, p.message),
                        Some(i) => error(entry, None, in_module(&bundle.modules[i], p.at, &p.message)),
                    };
                    diagnostics.push(d);
                }
            }
        }
    }

    for (entry, name, text, tokens) in &sheets {
        let lowered = match sheet::lower(text, name, tokens, manifest.source_maps) {
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
            None,
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

/// A bundle as read: its entry's text and its modules' sources.
struct Bundle<'a> {
    entry: &'a Entry,
    /// What the source map calls the entry.
    name: String,
    text: String,
    modules: Vec<BundledModule>,
}

struct BundledModule {
    id: EntryId,
    /// Absolute.
    path: PathBuf,
    /// Relative to the root, as the source map names it.
    relative: String,
    text: String,
}

fn read_bundle<'a>(
    root: &Path,
    entry: &'a Entry,
    text: &Text,
    modules: &[jaldi_contract::Bundled],
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<Bundle<'a>> {
    let mut ok = true;
    let (name, text) = match text {
        Text::File { path } => match std::fs::read_to_string(root.join(path)) {
            Ok(t) => (path.display().to_string(), t),
            Err(e) => {
                diagnostics.push(error(entry, None, format!("cannot read the entry {}: {e}", path.display())));
                return None;
            }
        },
        Text::Inline { content } => (format!("{}.entry.ts", entry.id), content.clone()),
    };
    let mut seen: HashSet<&EntryId> = HashSet::new();
    let mut read = Vec::new();
    for m in modules {
        if let Some(problem) = m.id.problem() {
            diagnostics.push(error(entry, None, format!("the bundled module id `{}` {problem}", m.id)));
            ok = false;
            continue;
        }
        if !seen.insert(&m.id) {
            diagnostics.push(error(entry, None, format!("the bundled module id `{}` is listed twice", m.id)));
            ok = false;
            continue;
        }
        let path = root.join(&m.source);
        match std::fs::read_to_string(&path) {
            Ok(t) => read.push(BundledModule {
                id: m.id.clone(),
                path,
                relative: m.source.display().to_string(),
                text: t,
            }),
            Err(e) => {
                diagnostics.push(error(
                    entry,
                    None,
                    format!("cannot read the bundled module `{}` at {}: {e}", m.id, m.source.display()),
                ));
                ok = false;
            }
        }
    }
    ok.then_some(Bundle {
        entry,
        name,
        text,
        modules: read,
    })
}

/// A problem in a bundled module, named in the message: a diagnostic's
/// position is in its entry's input, and a bundle's input is its entry.
fn in_module(m: &BundledModule, at: Option<Position>, message: &str) -> String {
    let where_ = at.map(|p| format!(":{}:{}", p.line, p.column)).unwrap_or_default();
    format!("in the bundled module `{}` ({}{where_}): {message}", m.id, m.relative)
}

/// Write an entry's output, its map, and its record.
#[allow(clippy::too_many_arguments)]
fn write(
    out_dir: &Path,
    entry: &Entry,
    extension: &str,
    output: &[u8],
    map: Option<&str>,
    input_hash: Hash,
    sheet: Option<jaldi_contract::SheetFacts>,
    bundle: Option<BundleFacts>,
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
        bundle,
    };
    put(&format!("{}.json", entry.id), record.to_json().as_bytes())?;
    Ok(record)
}
