//! The boundary end to end: the binary reads a manifest, refuses one from
//! another contract naming both versions, and answers one from its own.

use std::io::Write;
use std::process::{Command, Stdio};

use jaldi_contract::{Answer, Browsers, CONTRACT, Entry, EntryId, Kind, Manifest, Minify, Origin, Version, exit};

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

fn manifest(contract: Version) -> Manifest {
    Manifest {
        contract,
        root: "/work".into(),
        out_dir: ".jaldi".into(),
        browsers: Browsers {
            chrome: 150,
            safari: 26,
            firefox: 148,
        },
        source_maps: false,
        entries: vec![Entry {
            id: EntryId("pattern/combobox".into()),
            origin: Origin {
                krate: "framework".into(),
                file: "framework/framework/src/progressive.rs".into(),
                line: 74,
            },
            kind: Kind::Script {
                source: "framework/framework/static/patterns/combobox.js".into(),
                minify: Minify::AsAuthored,
            },
        }],
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
    let other = Version {
        major: CONTRACT.major,
        minor: CONTRACT.minor + 1,
    };
    let (status, stdout, stderr) = run(&manifest(other).to_json());
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
}

#[test]
fn a_manifest_that_does_not_lead_with_a_version_is_broken_not_refused() {
    let (status, _, stderr) = run(r#"{"entries": []}"#);
    assert_eq!(status, exit::BROKEN);
    assert!(stderr.contains("does not lead with a contract version"), "{stderr}");
}

#[test]
fn this_version_answers_every_entry_with_what_it_does_not_do_yet() {
    let (status, stdout, _) = run(&manifest(CONTRACT).to_json());
    assert_eq!(status, exit::ERRORS);
    let Answer::Produced(out) = Answer::from_json(&stdout).unwrap() else {
        panic!("{stdout}")
    };
    assert_eq!(out.contract, CONTRACT);
    assert!(out.produced.is_empty());
    assert_eq!(out.diagnostics.len(), 1);
    let d = &out.diagnostics[0];
    assert_eq!(d.entry.as_ref().unwrap().0, "pattern/combobox");
    assert!(d.message.ends_with("does not lower a script yet"), "{}", d.message);
    assert_eq!(d.origin.as_ref().unwrap().line, 74);
}
