//! TypeScript erasure with oxc: the types removed and nothing else. The
//! checker has already run, so what the parser refuses here is a syntax
//! error the checker also named; the transformer's diagnostics are the
//! constructs erasure cannot express (what `erasableSyntaxOnly` forbids).

use jaldi_contract::Position;
use oxc::allocator::Allocator;
use oxc::codegen::{Codegen, CodegenOptions};
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc::span::SourceType;
use oxc::transformer::{TransformOptions, Transformer};

#[derive(Debug)]
pub struct Erased {
    pub code: String,
    pub map: Option<String>,
}

pub fn erase(source: &str, name: &str, source_map: bool) -> Result<Erased, Vec<(Option<Position>, String)>> {
    let allocator = Allocator::default();
    let source_type = SourceType::ts().with_module(true);
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(report(source, &parsed.diagnostics));
    }
    let mut program = parsed.program;
    let scoping = SemanticBuilder::new().build(&program).semantic.into_scoping();
    let options = TransformOptions::default();
    let path = std::path::Path::new(name);
    let ret = Transformer::new(&allocator, path, &options).build_with_scoping(scoping, &mut program);
    if !ret.diagnostics.is_empty() {
        return Err(report(source, &ret.diagnostics));
    }
    let mut codegen_options = CodegenOptions::default();
    if source_map {
        codegen_options.source_map_path = Some(path.to_path_buf());
    }
    let out = Codegen::new().with_options(codegen_options).build(&program);
    Ok(Erased {
        code: out.code,
        map: out.map.map(|m| m.to_json_string()),
    })
}

fn report(source: &str, diagnostics: &[oxc::diagnostics::OxcDiagnostic]) -> Vec<(Option<Position>, String)> {
    diagnostics
        .iter()
        .map(|d| {
            let at = d.labels.first().map(|l| position(source, l.offset() as usize));
            (at, d.message.to_string())
        })
        .collect()
}

/// One-based line and column of a byte offset.
pub fn position(source: &str, offset: usize) -> Position {
    let offset = offset.min(source.len());
    let line = source[..offset].matches('\n').count() + 1;
    let column = offset - source[..offset].rfind('\n').map(|i| i + 1).unwrap_or(0) + 1;
    Position {
        line: line as u32,
        column: column as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erasure_removes_types_and_nothing_else() {
        let src = "import type { Parts, Context } from \"./x.parts.js\";\n\
                   export default function (parts: Parts, { signal }: Context): void {\n\
                   \x20 const n: number = 1;\n\
                   \x20 parts.wire.addEventListener(\"input\", () => n, { signal });\n\
                   }\n";
        let js = erase(src, "x.ts", false).unwrap().code;
        assert!(!js.contains("import type"), "{js}");
        assert!(!js.contains(": number"), "{js}");
        assert!(js.contains("export default function(parts, { signal })"), "{js}");
        assert!(js.contains("() => n"), "{js}");
    }

    #[test]
    fn a_parse_error_names_the_line() {
        let err = erase("const x: = 1;\n", "bad.ts", false).unwrap_err();
        assert_eq!(err[0].0, Some(Position { line: 1, column: 10 }), "{err:?}");
    }

    #[test]
    fn a_source_map_is_written_when_asked() {
        let out = erase("const x: number = 1;\n", "x.ts", true).unwrap();
        assert!(out.map.as_deref().unwrap().contains("\"sources\""), "{:?}", out.map);
    }
}
