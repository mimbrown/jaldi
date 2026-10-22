//! A module's imports, held to the output layout (`Kind::Module`): every
//! module is written to `out_dir` as `{id}.js`, so a relative import must
//! name another module of the manifest as `./{id}.js`, and a bare
//! specifier must be one a declarations entry declares. What the sources
//! resolve and what the outputs resolve are then the same graph, and
//! nothing outside `root` is reachable from it.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use jaldi_contract::{EntryId, Position};
use oxc::allocator::Allocator;
use oxc::ast::ast::Statement;
use oxc::parser::Parser;
use oxc::span::SourceType;

use crate::erase::position;

/// One module of the program, as the check reads it.
pub struct Module<'a> {
    pub id: &'a EntryId,
    /// Absolute.
    pub source: &'a Path,
    pub text: &'a str,
}

/// The bare specifiers a declaration file declares: its top-level
/// `declare module "…"` blocks. Parse errors are the checker's to report.
pub fn declared(text: &str) -> Vec<String> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, text, SourceType::d_ts()).parse();
    parsed
        .program
        .body
        .iter()
        .filter_map(|s| match s {
            Statement::TSExternalModuleDeclaration(m) => Some(m.id.value.display().to_string()),
            _ => None,
        })
        .collect()
}

/// Every import of `modules[index]` that the output layout would not
/// resolve, positioned at its specifier.
pub fn check(root: &Path, modules: &[Module<'_>], index: usize, declared: &HashSet<String>) -> Vec<(Position, String)> {
    let module = &modules[index];
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, module.text, SourceType::ts().with_module(true)).parse();
    // A parse error is the checker's (and erasure's) to report.
    if !parsed.diagnostics.is_empty() {
        return Vec::new();
    }
    let mut requests: Vec<(u32, String)> = Vec::new();
    for (specifier, at) in &parsed.module_record.requested_modules {
        for request in at {
            requests.push((request.span.start, specifier.to_string()));
        }
    }
    for dynamic in &parsed.module_record.dynamic_imports {
        let span = dynamic.module_request;
        let written = &module.text[span.start as usize..span.end as usize];
        if let Some(literal) = string_literal(written) {
            requests.push((span.start, literal));
        }
    }
    requests.sort();

    let mut problems = Vec::new();
    for (offset, specifier) in requests {
        if let Some(problem) = problem(root, modules, module, &specifier, declared) {
            problems.push((position(module.text, offset as usize), problem));
        }
    }
    problems
}

fn problem(root: &Path, modules: &[Module<'_>], module: &Module<'_>, specifier: &str, declared: &HashSet<String>) -> Option<String> {
    let relative = specifier.starts_with("./") || specifier.starts_with("../");
    if !relative {
        if specifier.starts_with('/') || specifier.contains(':') {
            return Some(format!(
                "imports `{specifier}`, which is outside the manifest's root: a module imports the manifest's other \
                 modules (`./{{id}}.js`) and the bare specifiers its declarations declare, nothing else"
            ));
        }
        if declared.contains(specifier) {
            return None;
        }
        return Some(format!(
            "imports `{specifier}`, which no declarations entry of the manifest declares (`declare module \"{specifier}\"`)"
        ));
    }
    let dir = module.source.parent().unwrap_or(Path::new(""));
    let resolved = normalize(&dir.join(specifier));
    if !resolved.starts_with(root) {
        return Some(format!("imports `{specifier}`, which is outside the manifest's root"));
    }
    let as_source = if resolved.extension().is_some_and(|e| e == "js") {
        resolved.with_extension("ts")
    } else {
        resolved.clone()
    };
    let Some(target) = modules.iter().find(|m| normalize(m.source) == as_source) else {
        return Some(format!(
            "imports `{specifier}`, which is not a module of this manifest: a module imports another as `./{{id}}.js`, \
             its source the `.ts` beside it"
        ));
    };
    let written = format!("./{}.js", target.id);
    if specifier != written {
        return Some(format!(
            "imports `{specifier}`, the module `{}`, which its output would not find: every module is written to the \
             output directory as `{{id}}.js`, so it is imported as `{written}`, its source beside its importer's",
            target.id
        ));
    }
    None
}

/// The contents of a quoted string literal with no escapes, as written.
fn string_literal(written: &str) -> Option<String> {
    let quote = written.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let inner = written.strip_prefix(quote)?.strip_suffix(quote)?;
    (!inner.contains('\\') && !inner.contains(quote)).then(|| inner.to_string())
}

/// `a/./b/../c` → `a/c`, lexically.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn modules<'a>(ids: &'a [EntryId], texts: &'a [&'a str], sources: &'a [PathBuf]) -> Vec<Module<'a>> {
        ids.iter()
            .zip(texts)
            .zip(sources)
            .map(|((id, text), source)| Module { id, source, text })
            .collect()
    }

    #[test]
    fn imports_resolve_only_as_the_output_will() {
        let root = Path::new("/w");
        let ids = [EntryId("main".into()), EntryId("wire".into()), EntryId("other-name".into())];
        let sources = [
            PathBuf::from("/w/rt/main.ts"),
            PathBuf::from("/w/rt/wire.ts"),
            PathBuf::from("/w/rt/other.ts"),
        ];
        let main = "import { A } from './wire.js';\n\
                    import { B } from './other.js';\n\
                    import x from '../../etc/x.js';\n\
                    import 'vendor/pm';\n\
                    import 'vendor/nope';\n\
                    import y from './missing.js';\n\
                    const z = import('./wire.js');\n\
                    const k = 'a';\n\
                    const w = import(`pattern/${k}`);\n";
        let texts = [main, "export const A = 1;", "export const B = 1;"];
        let ms = modules(&ids, &texts, &sources);
        let declared: HashSet<String> = ["vendor/pm".to_string()].into();
        let problems = check(root, &ms, 0, &declared);
        let lines: Vec<u32> = problems.iter().map(|(p, _)| p.line).collect();
        assert_eq!(lines, vec![2, 3, 5, 6], "{problems:?}");
        assert!(problems[0].1.contains("as `./other-name.js`"), "{}", problems[0].1);
        assert!(problems[1].1.contains("outside the manifest's root"), "{}", problems[1].1);
        assert!(problems[2].1.contains("no declarations entry"), "{}", problems[2].1);
        assert!(problems[3].1.contains("not a module of this manifest"), "{}", problems[3].1);
        assert_eq!(problems[0].0, Position { line: 2, column: 19 });
    }

    #[test]
    fn declarations_name_their_modules() {
        let d = "declare module \"vendor/prosemirror\" { export const x: number; }\ndeclare module 'b' {}\n";
        assert_eq!(declared(d), vec!["vendor/prosemirror".to_string(), "b".to_string()]);
    }
}
