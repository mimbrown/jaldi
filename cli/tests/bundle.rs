//! The bundle kind end to end (contract 4): the binary checks a bundle's
//! entry and modules as one program, links what the entry reaches, and
//! writes one minified script with its record and map, or nothing.
//!
//! The fixture (`tests/fixtures/bundle/`) is evaluated by `node`, which
//! these tests need on PATH: a bundle is correct when it prints what its
//! modules print unbundled (`expected.txt`).

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use jaldi_contract::{Answer, Bundled, CONTRACT, Diagnostic, Entry, EntryId, Kind, Manifest, Origin, Produced, Severity, Text, exit};

const FIXTURE: &[&str] = &[
    "a",
    "b",
    "c",
    "cycle-a",
    "cycle-b",
    "d",
    "reexport",
    "effects",
    "shadow",
    "types",
    "unreached",
];

fn run(manifest: &Manifest) -> (i32, Vec<Produced>, Vec<Diagnostic>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_jaldi"))
        .args(["lower", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn jaldi");
    child.stdin.take().unwrap().write_all(manifest.to_json().as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    let stdout = String::from_utf8(out.stdout).unwrap();
    match Answer::from_json(&stdout) {
        Ok(Answer::Produced(o)) => (out.status.code().unwrap(), o.produced, o.diagnostics),
        other => panic!("{other:?}\n{}", String::from_utf8_lossy(&out.stderr)),
    }
}

/// A workspace holding the fixture's modules under `app/rt/`.
fn workspace() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let rt = dir.path().join("app/rt");
    std::fs::create_dir_all(&rt).unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bundle");
    for name in FIXTURE {
        std::fs::copy(fixture.join(format!("{name}.ts")), rt.join(format!("{name}.ts"))).unwrap();
    }
    dir
}

fn fixture(name: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bundle").join(name)).unwrap()
}

fn origin() -> Origin {
    Origin {
        krate: "app".into(),
        file: "app/src/main.rs".into(),
        line: 7,
    }
}

fn bundle(entry: &str, modules: &[&str]) -> Entry {
    Entry {
        id: EntryId("runtime".into()),
        origin: origin(),
        kind: Kind::Bundle {
            entry: Text::Inline { content: entry.into() },
            modules: modules
                .iter()
                .map(|m| Bundled {
                    id: EntryId((*m).into()),
                    source: format!("app/rt/{m}.ts").into(),
                })
                .collect(),
        },
    }
}

fn manifest(root: &Path, source_maps: bool, entries: Vec<Entry>) -> Manifest {
    Manifest {
        contract: CONTRACT,
        root: root.to_path_buf(),
        out_dir: "app/.jaldi".into(),
        source_maps,
        entries,
    }
}

/// What `node` prints evaluating the bundle as a module.
fn evaluate(bundle: &Path) -> String {
    let module = bundle.with_extension("mjs");
    std::fs::copy(bundle, &module).unwrap();
    let out = Command::new("node")
        .arg(&module)
        .output()
        .expect("these tests evaluate the bundle with `node`, which must be on PATH");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

fn errors(diagnostics: &[Diagnostic]) -> Vec<&Diagnostic> {
    diagnostics.iter().filter(|d| d.severity == Severity::Error).collect()
}

#[test]
fn a_bundle_prints_what_its_modules_print_and_leaves_out_what_the_entry_does_not_use() {
    let dir = workspace();
    let (status, produced, diagnostics) = run(&manifest(dir.path(), false, vec![bundle(&fixture("entry.ts"), FIXTURE)]));
    assert_eq!(status, exit::CLEAN, "{diagnostics:?}");
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let out = dir.path().join("app/.jaldi");
    let code = std::fs::read_to_string(out.join("runtime.js")).unwrap();
    assert_eq!(evaluate(&out.join("runtime.js")), fixture("expected.txt"));
    // Unused exports, an unused private function, a type-only module and
    // a listed module nothing imports: none of it is in the output.
    assert!(!code.contains("UNUSED_MARKER"), "{code}");
    // Minified: one line, top-level names mangled.
    assert_eq!(code.trim_end().lines().count(), 1, "{code}");
    assert!(!code.contains("documentLike"), "{code}");

    let record = &produced[0];
    assert_eq!(record.id, EntryId("runtime".into()));
    assert_eq!(record.source_map, None);
    let facts = record.bundle.as_ref().expect("a bundle's record says what went in");
    let modules: Vec<&str> = facts.modules.iter().map(|m| m.0.as_str()).collect();
    assert_eq!(
        modules,
        ["a", "b", "c", "d", "reexport", "cycle-b", "cycle-a", "effects", "shadow"],
        "evaluation order, without the type-only module and the unreached one"
    );
    assert!(facts.imports.is_empty(), "{facts:?}");

    // The record's input hash is the entry's text, then every listed
    // module's source in the order listed.
    let mut inputs: Vec<Vec<u8>> = vec![fixture("entry.ts").into_bytes()];
    inputs.extend(FIXTURE.iter().map(|m| fixture(&format!("{m}.ts")).into_bytes()));
    let inputs: Vec<&[u8]> = inputs.iter().map(Vec::as_slice).collect();
    assert_eq!(record.input_hash, jaldi_contract::input_hash(&inputs));
    let on_disk = Produced::from_json(&std::fs::read_to_string(out.join("runtime.json")).unwrap()).unwrap();
    assert_eq!(&on_disk, record);
    // Modules are not written on their own.
    assert!(!out.join("a.js").exists());
}

#[test]
fn a_bundle_map_points_into_the_typescript_sources() {
    let dir = workspace();
    let (status, produced, diagnostics) = run(&manifest(dir.path(), true, vec![bundle(&fixture("entry.ts"), FIXTURE)]));
    assert_eq!(status, exit::CLEAN, "{diagnostics:?}");
    assert_eq!(produced[0].source_map.as_deref(), Some(Path::new("runtime.js.map")));
    let out = dir.path().join("app/.jaldi");
    let code = std::fs::read_to_string(out.join("runtime.js")).unwrap();
    let json = std::fs::read_to_string(out.join("runtime.js.map")).unwrap();
    let map = oxc_sourcemap::SourceMap::from_json_string(&json).unwrap();
    let sources: Vec<&str> = map.get_sources().collect();
    assert!(sources.contains(&"app/rt/a.ts"), "{sources:?}");
    assert!(sources.contains(&"runtime.entry.ts"), "{sources:?}");
    assert!(!sources.iter().any(|s| s.contains("unreached")), "{sources:?}");
    // The first use of b's marker in the output (its `Reflect.set`) maps to
    // its line in b.ts, and a's to a.ts: the minifier's map composed with
    // each module's, through erasure.
    let table = map.generate_lookup_table();
    for (needle, source, line) in [("SIDE_EFFECT_B", "app/rt/b.ts", 17), ("SIDE_EFFECT_A", "app/rt/a.ts", 2)] {
        let column = code
            .find(&format!("\"{needle}\""))
            .or_else(|| code.find(&format!("`{needle}`")))
            .unwrap_or_else(|| code.find(needle).unwrap_or_else(|| panic!("{needle} is in the output")));
        let token = map.lookup_token(&table, 0, column as u32).expect("the output is mapped");
        let id = token.get_source_id().expect("mapped to a source");
        assert_eq!(map.get_source(id), Some(source), "{needle}");
        assert_eq!(token.get_src_line() + 1, line, "{needle}");
        assert!(
            map.get_source_content(id).is_some_and(|c| c.contains(needle)),
            "the map carries its sources"
        );
    }
}

#[test]
fn a_bare_specifier_stays_an_import_of_the_output() {
    let dir = workspace();
    std::fs::write(
        dir.path().join("app/rt/vendor.d.ts"),
        "declare module \"vendor/thing\" { export const thing: number; }\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join("app/rt/uses.ts"),
        "import { thing } from 'vendor/thing';\nimport 'vendor/effect';\nexport function twice(): number { return thing * 2; }\n",
    )
    .unwrap();
    std::fs::write(dir.path().join("app/rt/effect.d.ts"), "declare module \"vendor/effect\" {}\n").unwrap();
    let declarations = |id: &str, file: &str| Entry {
        id: EntryId(id.into()),
        origin: origin(),
        kind: Kind::Declarations {
            source: format!("app/rt/{file}").into(),
        },
    };
    let entries = vec![
        declarations("vendor", "vendor.d.ts"),
        declarations("effect", "effect.d.ts"),
        bundle("import { twice } from './uses.js';\nconsole.log(twice());\n", &["uses"]),
    ];
    let (status, produced, diagnostics) = run(&manifest(dir.path(), false, entries));
    assert_eq!(status, exit::CLEAN, "{diagnostics:?}");
    let code = std::fs::read_to_string(dir.path().join("app/.jaldi/runtime.js")).unwrap();
    assert!(code.contains("from\"vendor/thing\""), "{code}");
    assert!(code.contains("import\"vendor/effect\""), "{code}");
    let facts = produced[0].bundle.as_ref().unwrap();
    assert_eq!(facts.imports, ["vendor/thing", "vendor/effect"]);
}

#[test]
fn a_type_error_in_a_bundled_module_names_it_and_nothing_is_written() {
    let dir = workspace();
    std::fs::write(
        dir.path().join("app/rt/d.ts"),
        "export const known: number = 'not a number';\nexport function f(): string { return 'f'; }\n",
    )
    .unwrap();
    let (status, produced, diagnostics) = run(&manifest(dir.path(), false, vec![bundle(&fixture("entry.ts"), FIXTURE)]));
    assert_eq!(status, exit::ERRORS);
    assert!(produced.is_empty());
    let errors = errors(&diagnostics);
    assert!(
        errors.iter().any(|d| d.entry == Some(EntryId("runtime".into()))
            && d.message.contains("in the bundled module app/rt/d.ts:1:")
            && d.message.contains("TS2322")),
        "{errors:?}"
    );
    assert!(!dir.path().join("app/.jaldi/runtime.js").exists());
    assert!(!dir.path().join("app/.jaldi/runtime.json").exists());
}

#[test]
fn a_type_error_in_the_entry_is_positioned_in_it() {
    let dir = workspace();
    let entry = "import { greet } from './a.js';\nconst n: number = greet('x');\nconsole.log(n);\n";
    let (status, produced, diagnostics) = run(&manifest(dir.path(), false, vec![bundle(entry, &["a"])]));
    assert_eq!(status, exit::ERRORS);
    assert!(produced.is_empty());
    let error = errors(&diagnostics)[0];
    assert_eq!(error.entry, Some(EntryId("runtime".into())));
    assert_eq!(error.at.map(|p| p.line), Some(2), "{error:?}");
    assert_eq!(error.origin, Some(origin()));
}

#[test]
fn an_entry_import_that_is_no_bundled_module_lists_the_ids() {
    let dir = workspace();
    let entry = "import { greet } from './alpha.js';\nconsole.log(greet('x'));\n";
    let (status, produced, diagnostics) = run(&manifest(dir.path(), false, vec![bundle(entry, &["a", "d"])]));
    assert_eq!(status, exit::ERRORS);
    assert!(produced.is_empty());
    let found = errors(&diagnostics)
        .into_iter()
        .find(|d| d.message.contains("not a module of this bundle"))
        .unwrap_or_else(|| panic!("{diagnostics:?}"));
    assert!(found.message.contains("`./a.js`, `./d.js`"), "{}", found.message);
    assert_eq!(found.at.map(|p| (p.line, p.column)), Some((1, 23)));
}

#[test]
fn export_star_is_refused_at_its_statement_naming_the_form_to_write() {
    let dir = workspace();
    std::fs::write(dir.path().join("app/rt/star.ts"), "// re-exports\nexport * from './d.js';\n").unwrap();
    let entry = "import { f } from './star.js';\nconsole.log(f());\n";
    let (status, produced, diagnostics) = run(&manifest(dir.path(), false, vec![bundle(entry, &["star", "d"])]));
    assert_eq!(status, exit::ERRORS);
    assert!(produced.is_empty());
    let found = errors(&diagnostics)
        .into_iter()
        .find(|d| d.message.contains("export *"))
        .unwrap_or_else(|| panic!("{diagnostics:?}"));
    assert!(
        found.message.contains("in the bundled module `star` (app/rt/star.ts:2:1)"),
        "{}",
        found.message
    );
    assert!(found.message.contains("export { a, b } from './d.js'"), "{}", found.message);
    assert!(!dir.path().join("app/.jaldi/runtime.js").exists());
}

#[test]
fn a_literal_dynamic_import_of_a_bundled_module_is_refused() {
    let dir = workspace();
    let entry = "const d = import('./d.js');\nconsole.log(d);\n";
    let (status, produced, diagnostics) = run(&manifest(dir.path(), false, vec![bundle(entry, &["d"])]));
    assert_eq!(status, exit::ERRORS);
    assert!(produced.is_empty());
    let found = errors(&diagnostics)
        .into_iter()
        .find(|d| d.message.contains("dynamically"))
        .unwrap_or_else(|| panic!("{diagnostics:?}"));
    assert_eq!(found.at.map(|p| p.line), Some(1));
}

#[test]
fn an_entry_that_exports_is_refused() {
    let dir = workspace();
    let entry = "import { f } from './d.js';\nexport const g = f;\n";
    let (status, _, diagnostics) = run(&manifest(dir.path(), false, vec![bundle(entry, &["d"])]));
    assert_eq!(status, exit::ERRORS);
    let found = errors(&diagnostics)
        .into_iter()
        .find(|d| d.message.contains("exports nothing"))
        .unwrap_or_else(|| panic!("{diagnostics:?}"));
    assert_eq!(found.at.map(|p| p.line), Some(2));
}

#[test]
fn a_bundled_module_imported_under_another_name_than_its_id_is_named() {
    let dir = workspace();
    // `b` imports `./types.js`; listed as `shapes`, the import is wrong.
    let entries = vec![Entry {
        id: EntryId("runtime".into()),
        origin: origin(),
        kind: Kind::Bundle {
            entry: Text::Inline {
                content: "import { greet } from './b.js';\nconsole.log(greet('x'));\n".into(),
            },
            modules: vec![
                Bundled {
                    id: EntryId("b".into()),
                    source: "app/rt/b.ts".into(),
                },
                Bundled {
                    id: EntryId("shapes".into()),
                    source: "app/rt/types.ts".into(),
                },
            ],
        },
    }];
    let (status, _, diagnostics) = run(&manifest(dir.path(), false, entries));
    assert_eq!(status, exit::ERRORS);
    assert!(
        errors(&diagnostics).iter().any(|d| d.message.contains("as `./shapes.js`")),
        "{diagnostics:?}"
    );
}
