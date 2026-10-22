//! The TypeScript check, in process with tsrs (the Rust port of the
//! TypeScript 7 compiler): one program of every enhancement, module and
//! declaration file of a manifest, strict, erasable syntax only; each
//! enhancement against its header, its default export pinned to the
//! header's `Mount` by a probe module written beside a generated
//! `tsconfig.json`.
//! The sources are read where they are; only the probes and the config
//! are written, to a temporary directory removed afterwards.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use jaldi_contract::{Diagnostic, EntryId, Origin, Position, Severity};
use tsrs_ast::Diagnostic as TsDiagnostic;
use tsrs_core::{P, tspath};
use tsrs_diagnostics::Category;
use tsrs_execute::tsc::System;
use tsrs_vfs::{FS, bundled, osvfs};

pub struct Checked {
    pub id: EntryId,
    pub origin: Origin,
    /// Absolute.
    pub source: PathBuf,
    /// Absolute. An enhancement's header, which a probe pins its default
    /// export to; `None` for a module or a declaration file.
    pub header: Option<PathBuf>,
}

/// The compiler options every enhancement is checked under. Fixed here,
/// not in the manifest: they are the framework's checking regime and
/// change with the contract, deliberately.
const OPTIONS: &str = r#"{
    "strict": true,
    "noEmit": true,
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "types": [],
    "erasableSyntaxOnly": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true
  }"#;

pub fn run(entries: &[Checked]) -> Vec<Diagnostic> {
    let dir = std::env::temp_dir().join(format!("jaldi-check-{}", std::process::id()));
    let result = run_in(&dir, entries);
    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn run_in(dir: &Path, entries: &[Checked]) -> Vec<Diagnostic> {
    if let Err(e) = std::fs::create_dir_all(dir) {
        return vec![run_problem(format!("cannot create {}: {e}", dir.display()))];
    }
    let mut files: Vec<String> = Vec::new();
    let mut probes: Vec<(String, &Checked)> = Vec::new();
    for entry in entries {
        files.push(entry.source.to_string_lossy().into_owned());
        let Some(header) = &entry.header else { continue };
        let module = entry.source.with_extension("js");
        let header = header.to_string_lossy().replace(".d.ts", ".js");
        let probe = dir.join(format!("{}.check.ts", entry.id));
        let text = format!(
            "// Pins the default export of {} to the header's `Mount`.\n\
             import mount from \"{}\";\n\
             import type {{ Mount }} from \"{header}\";\n\
             const _mount: Mount = mount;\n",
            entry.source.display(),
            module.display()
        );
        if let Err(e) = std::fs::write(&probe, text) {
            return vec![run_problem(format!("cannot write {}: {e}", probe.display()))];
        }
        let probe = probe.to_string_lossy().into_owned();
        files.push(probe.clone());
        probes.push((normalize(&probe), entry));
    }
    let config = format!(
        "{{\n  \"compilerOptions\": {OPTIONS},\n  \"files\": [{}]\n}}\n",
        files
            .iter()
            .map(|f| serde_json::to_string(f).expect("a path serializes"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let tsconfig = dir.join("tsconfig.json");
    if let Err(e) = std::fs::write(&tsconfig, config) {
        return vec![run_problem(format!("cannot write {}: {e}", tsconfig.display()))];
    }

    let sink: Arc<Mutex<Vec<P<TsDiagnostic>>>> = Arc::new(Mutex::new(Vec::new()));
    let text: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let sys: &'static Sys = Box::leak(Box::new(Sys::new(dir, sink.clone(), text.clone())));
    let args = vec![
        "-p".to_string(),
        tsconfig.to_string_lossy().into_owned(),
        "--noEmit".to_string(),
        "--pretty".to_string(),
        "false".to_string(),
    ];
    let result = tsrs_execute::execute::command_line(sys, args);

    let mut out = Vec::new();
    for d in sink.lock().unwrap_or_else(|e| e.into_inner()).iter() {
        out.push(translate(d, entries, &probes));
    }
    let printed = String::from_utf8_lossy(&text.lock().unwrap_or_else(|e| e.into_inner()))
        .trim()
        .to_string();
    if out.is_empty() && !matches!(result.status, tsrs_execute::tsc::ExitStatus::Success) {
        out.push(run_problem(format!(
            "the check ended with {:?}{}",
            result.status,
            if printed.is_empty() {
                String::new()
            } else {
                format!(": {printed}")
            }
        )));
    }
    out
}

fn run_problem(message: String) -> Diagnostic {
    Diagnostic {
        entry: None,
        severity: Severity::Error,
        message,
        at: None,
        origin: None,
    }
}

fn normalize(path: &str) -> String {
    tspath::normalize_path(path)
}

/// A tsrs diagnostic as the contract's: attributed to the entry whose
/// source, header or probe it is in, positioned in the source when it is
/// there, and otherwise naming the file in the message.
fn translate(d: &TsDiagnostic, entries: &[Checked], probes: &[(String, &Checked)]) -> Diagnostic {
    let severity = match d.category() {
        Category::Error => Severity::Error,
        _ => Severity::Warning,
    };
    let mut message = d.localize();
    for chained in d.message_chain() {
        message.push_str("\n  ");
        message.push_str(&chained.localize());
    }
    let code = d.code();
    let message = format!("TS{code}: {message}");
    let Some(file) = d.file() else {
        return Diagnostic {
            entry: None,
            severity,
            message,
            at: None,
            origin: None,
        };
    };
    let file_name = file.file_name().to_string();
    let at = d.pos().map(|pos| {
        let (line, character) = tsrs_scanner::get_ecma_line_and_utf16_character_of_position(&*file, pos);
        Position {
            line: line as u32 + 1,
            column: character + 1,
        }
    });
    let is = |p: &Path| normalize(&p.to_string_lossy()) == file_name;
    if let Some(entry) = entries.iter().find(|e| is(&e.source)) {
        return Diagnostic {
            entry: Some(entry.id.clone()),
            severity,
            message,
            at,
            origin: Some(entry.origin.clone()),
        };
    }
    if let Some((entry, header)) = entries.iter().find_map(|e| e.header.as_ref().filter(|h| is(h)).map(|h| (e, h))) {
        let where_ = at.map(|p| format!(":{}:{}", p.line, p.column)).unwrap_or_default();
        let message = format!("in the header {}{where_}: {message}", header.display());
        return Diagnostic {
            entry: Some(entry.id.clone()),
            severity,
            message,
            at: None,
            origin: Some(entry.origin.clone()),
        };
    }
    if let Some((_, entry)) = probes.iter().find(|(p, _)| *p == file_name) {
        let message = format!("the default export is not the header's `Mount`: {message}");
        return Diagnostic {
            entry: Some(entry.id.clone()),
            severity,
            message,
            at: None,
            origin: Some(entry.origin.clone()),
        };
    }
    let where_ = at.map(|p| format!(":{}:{}", p.line, p.column)).unwrap_or_default();
    Diagnostic {
        entry: None,
        severity,
        message: format!("{file_name}{where_}: {message}"),
        at: None,
        origin: None,
    }
}

/// tsrs's `System` over the OS file system, with the diagnostics
/// collected rather than printed.
struct Sys {
    fs: Arc<dyn FS>,
    default_library_path: String,
    cwd: String,
    start: Instant,
    sink: Box<dyn Fn(P<TsDiagnostic>) + Send + Sync>,
    text: Arc<Mutex<Vec<u8>>>,
}

impl Sys {
    fn new(cwd: &Path, diagnostics: Arc<Mutex<Vec<P<TsDiagnostic>>>>, text: Arc<Mutex<Vec<u8>>>) -> Sys {
        Sys {
            fs: Arc::new(bundled::wrap_fs(osvfs::fs())),
            default_library_path: bundled::default_lib_path(),
            cwd: tspath::normalize_path(&cwd.to_string_lossy()),
            start: Instant::now(),
            sink: Box::new(move |d| diagnostics.lock().unwrap_or_else(|e| e.into_inner()).push(d)),
            text,
        }
    }
}

impl System for Sys {
    fn fs(&self) -> Arc<dyn FS> {
        Arc::clone(&self.fs)
    }

    fn default_library_path(&self) -> &str {
        &self.default_library_path
    }

    fn get_current_directory(&self) -> &str {
        &self.cwd
    }

    fn write(&self, text: &str) {
        let _ = self.text.lock().unwrap_or_else(|e| e.into_inner()).write_all(text.as_bytes());
    }

    fn flush(&self) {}

    fn write_output_is_tty(&self) -> bool {
        false
    }

    fn get_environment_variable(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }

    fn spawn(&self, _: &[String], _: &str, _: Option<Box<dyn Write + Send>>) -> Result<tsrs_execute::tsc::ReadWriteCloser, String> {
        Err("jaldi runs no content mapper".to_string())
    }

    fn now(&self) -> Instant {
        Instant::now()
    }

    fn since_start(&self) -> Duration {
        self.start.elapsed()
    }

    fn diagnostic_sink(&self) -> Option<&(dyn Fn(P<TsDiagnostic>) + Sync)> {
        Some(&*self.sink)
    }
}
