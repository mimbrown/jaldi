//! The boundary end to end: the binary reads a manifest, refuses one from
//! another contract naming both versions, and lowers one from its own —
//! checking, erasing and writing beside the sources.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use jaldi_contract::{Answer, CONTRACT, Entry, EntryId, Kind, Manifest, Origin, Produced, Severity, Text, exit};

fn run(stdin: &str) -> (i32, String, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_jaldi"))
        .args(["lower", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn jaldi");
    child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    (
        out.status.code().unwrap(),
        String::from_utf8(out.stdout).unwrap(),
        String::from_utf8(out.stderr).unwrap(),
    )
}

const HEADER: &str = "export interface Parts { wire: HTMLInputElement }\n\
                      export interface Context { signal: AbortSignal }\n\
                      export type Mount = (parts: Parts, context: Context) => void;\n";

const GOOD: &str = "import type { Parts, Context } from \"./chips.parts.js\";\n\
                    export default function (parts: Parts, { signal }: Context): void {\n\
                    \x20 const n: number = 1;\n\
                    \x20 parts.wire.addEventListener(\"input\", () => n, { signal });\n\
                    }\n";

/// A workspace with one enhancement and its header under `app/src/`.
fn workspace(source: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("app/src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("chips.parts.d.ts"), HEADER).unwrap();
    std::fs::write(src.join("chips.ts"), source).unwrap();
    dir
}

fn origin() -> Origin {
    Origin {
        krate: "app".into(),
        file: "app/src/ui.rs".into(),
        line: 12,
    }
}

fn manifest(root: &Path, contract: u32, entries: Vec<Entry>) -> Manifest {
    Manifest {
        contract,
        root: root.to_path_buf(),
        out_dir: "app/.jaldi".into(),
        source_maps: false,
        entries,
    }
}

fn chips() -> Entry {
    Entry {
        id: EntryId("chips".into()),
        origin: origin(),
        kind: Kind::Enhancement {
            source: "app/src/chips.ts".into(),
            header: "app/src/chips.parts.d.ts".into(),
        },
    }
}

fn produced(stdout: &str) -> (Vec<Produced>, Vec<jaldi_contract::Diagnostic>) {
    match Answer::from_json(stdout).unwrap() {
        Answer::Produced(out) => (out.produced, out.diagnostics),
        other => panic!("{other:?}"),
    }
}

#[test]
fn version_names_the_tool_and_the_contract() {
    let out = Command::new(env!("CARGO_BIN_EXE_jaldi")).arg("version").output().unwrap();
    let text = String::from_utf8(out.stdout).unwrap();
    assert_eq!(text, format!("jaldi {}\ncontract {CONTRACT}\n", env!("CARGO_PKG_VERSION")));
}

#[test]
fn another_contract_is_refused_naming_both() {
    let ws = workspace(GOOD);
    let other = CONTRACT + 1;
    let (status, stdout, stderr) = run(&manifest(ws.path(), other, vec![chips()]).to_json());
    assert_eq!(status, exit::REFUSED, "{stderr}");
    assert!(
        stderr.contains(&format!("contract {other}")) && stderr.contains(&format!("contract {CONTRACT}")),
        "{stderr}"
    );
    assert_eq!(
        Answer::from_json(&stdout).unwrap(),
        Answer::Refused {
            contract: CONTRACT,
            manifest: other,
            tool: format!("jaldi {}", env!("CARGO_PKG_VERSION"))
        }
    );
    assert!(!ws.path().join("app/.jaldi").exists(), "nothing is written on a refusal");
}

#[test]
fn a_manifest_that_does_not_lead_with_a_version_is_broken_not_refused() {
    let (status, _, stderr) = run(r#"{"entries": []}"#);
    assert_eq!(status, exit::BROKEN);
    assert!(stderr.contains("does not lead with a contract version"), "{stderr}");
}

#[test]
fn an_enhancement_is_checked_erased_and_written_beside_its_source() {
    let ws = workspace(GOOD);
    let (status, stdout, stderr) = run(&manifest(ws.path(), CONTRACT, vec![chips()]).to_json());
    assert_eq!(status, exit::CLEAN, "{stdout}\n{stderr}");
    let (produced, diagnostics) = produced(&stdout);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(produced.len(), 1);
    let record = &produced[0];
    assert_eq!(record.output, Path::new("chips.js"));
    assert_eq!(record.source_map, None);
    let out = ws.path().join("app/.jaldi");
    let js = std::fs::read_to_string(out.join("chips.js")).unwrap();
    assert!(!js.contains(": number") && !js.contains("import type"), "{js}");
    assert!(js.contains("export default function(parts, { signal })"), "{js}");
    // The record on disk is the one in the answer, and the hashes are the inputs' and outputs'.
    let on_disk = Produced::from_json(&std::fs::read_to_string(out.join("chips.json")).unwrap()).unwrap();
    assert_eq!(&on_disk, record);
    assert_eq!(
        record.input_hash,
        jaldi_contract::input_hash(&[GOOD.as_bytes(), HEADER.as_bytes()]),
        "the hash is over the source then the header"
    );
    assert_ne!(record.input_hash, record.output_hash);
}

#[test]
fn a_type_error_is_positioned_in_the_source_and_nothing_is_written() {
    let ws = workspace(&GOOD.replace("const n: number = 1;", "const n: number = \"one\";"));
    let (status, stdout, _) = run(&manifest(ws.path(), CONTRACT, vec![chips()]).to_json());
    assert_eq!(status, exit::ERRORS, "{stdout}");
    let (produced, diagnostics) = produced(&stdout);
    assert!(produced.is_empty());
    assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
    let d = &diagnostics[0];
    assert_eq!(d.severity, Severity::Error);
    assert_eq!(d.entry.as_ref().unwrap().0, "chips");
    assert_eq!(d.origin.as_ref().unwrap().line, 12);
    assert_eq!(d.at.map(|p| (p.line, p.column)), Some((3, 9)), "{d:?}");
    assert!(d.message.starts_with("TS2322:"), "{}", d.message);
    assert!(!ws.path().join("app/.jaldi/chips.js").exists());
}

#[test]
fn a_default_export_that_is_not_a_mount_is_named() {
    let ws = workspace("export default function (n: number): void { void n; }\n");
    let (status, stdout, _) = run(&manifest(ws.path(), CONTRACT, vec![chips()]).to_json());
    assert_eq!(status, exit::ERRORS, "{stdout}");
    let (_, diagnostics) = produced(&stdout);
    assert!(
        diagnostics
            .iter()
            .any(|d| d.message.starts_with("the default export is not the header's `Mount`")),
        "{diagnostics:?}"
    );
}

#[test]
fn a_sheet_is_lowered_with_its_rules_as_data() {
    let ws = workspace(GOOD);
    let sheet = Entry {
        id: EntryId("sheet".into()),
        origin: origin(),
        kind: Kind::Sheet {
            source: Text::Inline {
                content: "@layer base { :root { --gap: 1rem } .chip { gap: var(--gap); color: rgb(255 0 0 / 50%) } }".into(),
            },
            tokens: vec!["--gap".into()],
        },
    };
    let (status, stdout, stderr) = run(&manifest(ws.path(), CONTRACT, vec![sheet]).to_json());
    assert_eq!(status, exit::CLEAN, "{stdout}\n{stderr}");
    let (produced, _) = produced(&stdout);
    let facts = produced[0].sheet.as_ref().unwrap();
    assert_eq!(facts.rules.len(), 2);
    assert_eq!(facts.rules[1].selector, ".chip");
    assert_eq!(facts.rules[1].layer.as_deref(), Some("base"));
    assert_eq!(facts.rules[1].declarations[1].name, "color");
    assert_eq!(facts.rules[1].declarations[1].value, "#ff000080"); // printed canonically
    let css = std::fs::read_to_string(ws.path().join("app/.jaldi/sheet.css")).unwrap();
    assert!(css.starts_with("@layer base{"), "{css}");
}

#[test]
fn the_contract_invokes_the_tool_by_the_one_convention() {
    // `JALDI` names the binary; the answer comes back parsed.
    let ws = workspace(GOOD);
    // SAFETY: tests in this file do not race on the environment.
    unsafe { std::env::set_var("JALDI", env!("CARGO_BIN_EXE_jaldi")) };
    let answer = jaldi_contract::invoke::lower(&manifest(ws.path(), CONTRACT, vec![chips()])).unwrap();
    assert!(matches!(answer, Answer::Produced(ref out) if out.produced.len() == 1), "{answer:?}");
    let refused = jaldi_contract::invoke::lower(&manifest(ws.path(), CONTRACT + 1, vec![chips()])).unwrap();
    assert!(matches!(refused, Answer::Refused { .. }), "{refused:?}");
    unsafe { std::env::set_var("JALDI", "/nonexistent/jaldi") };
    let absent = jaldi_contract::invoke::lower(&manifest(ws.path(), CONTRACT, vec![])).unwrap_err();
    assert!(matches!(absent, jaldi_contract::invoke::Failed::Absent), "{absent:?}");
    unsafe { std::env::remove_var("JALDI") };
}

#[test]
fn an_id_with_a_separator_is_refused_per_entry() {
    let ws = workspace(GOOD);
    let mut bad = chips();
    bad.id = EntryId("ui/chips".into());
    let (status, stdout, _) = run(&manifest(ws.path(), CONTRACT, vec![bad]).to_json());
    assert_eq!(status, exit::ERRORS);
    let (_, diagnostics) = produced(&stdout);
    assert!(diagnostics[0].message.contains("one path segment"), "{diagnostics:?}");
}
