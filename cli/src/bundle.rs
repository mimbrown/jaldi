//! The bundle kind (contract 4): a linker of our own over oxc, for the one
//! graph shape the framework writes — its own ESM modules, importing each
//! other as `./{id}.js`, bare specifiers left to the import map at run
//! time, no CommonJS, no `export *`.
//!
//! Scope hoisting the way rollup does it:
//!
//! 1. Load: from the entry, each module reached is parsed as TypeScript,
//!    erased (the same erasure as a module's), and its imports and
//!    exports read off the erased form.
//! 2. Order: ESM evaluation order, depth-first post-order over each
//!    module's requests in source order; a module in progress is skipped,
//!    so a cycle evaluates the way the browser would evaluate it.
//! 3. Name: every top-level binding gets one name unique across the
//!    bundle and distinct from every global any module reads; an import
//!    binding takes the name of what it resolves to (so it stays live); a
//!    nested binding a rename would capture is renamed out of the way.
//! 4. Emit: each module printed with its imports dropped and `export`
//!    stripped (an anonymous default named), each with its source map,
//!    concatenated in order; the bare imports and the namespace objects
//!    first.
//! 5. Shake: the concatenation parsed as one module and minified by oxc,
//!    which drops what nothing reads and keeps every statement that may
//!    have an effect. Its map is composed with the concatenation's, so
//!    the output maps into the TypeScript sources.
//!
//! A shape outside the graph is a [`Problem`] at the statement, never an
//! exit: the run answers it as a diagnostic and writes nothing.

use std::collections::{HashMap, HashSet};

use jaldi_contract::{BundleFacts, EntryId, Position};
use oxc::allocator::{Allocator, Vec as AVec};
use oxc::ast::ast::*;
use oxc::ast::builder::AstBuilder;
use oxc::codegen::{Codegen, CodegenOptions};
use oxc::mangler::MangleOptions;
use oxc::minifier::{CompressOptions, Minifier, MinifierOptions};
use oxc::parser::Parser;
use oxc::semantic::{Scoping, SemanticBuilder, SymbolFlags, SymbolId};
use oxc::span::{GetSpan, SPAN, SourceType, Span};
use oxc::transformer::{TransformOptions, Transformer};
use oxc_sourcemap::{ConcatSourceMapBuilder, SourceMap};

use crate::erase::position;

/// One file of the bundle: the entry or a module.
pub struct File<'a> {
    /// The module's id; for the entry, the bundle's.
    pub id: &'a EntryId,
    /// What the source map calls it: the source's path relative to the
    /// manifest's root, or `{id}.entry.ts` for an inline entry.
    pub name: String,
    pub text: &'a str,
}

pub struct Input<'a> {
    pub entry: File<'a>,
    pub modules: Vec<File<'a>>,
    /// The bare specifiers the manifest's declarations declare.
    pub declared: &'a HashSet<String>,
    pub source_map: bool,
}

pub struct Bundled {
    pub code: String,
    pub map: Option<String>,
    pub facts: BundleFacts,
}

/// Why there is no bundle, at a statement of one of its files.
#[derive(Debug)]
pub struct Problem {
    /// `None` for the entry, else the index of the module.
    pub file: Option<usize>,
    pub at: Option<Position>,
    pub message: String,
}

type ModuleId = usize;

#[derive(Clone)]
enum Source {
    Module(ModuleId),
    External(String),
}

enum Imported {
    Name(String),
    Default,
    Namespace,
}

struct Import {
    local: SymbolId,
    from: Source,
    imported: Imported,
}

enum Export {
    /// A binding of this module (an import binding too, for `export { x }` of an import).
    Local(SymbolId),
    /// An anonymous `export default …`, named by the linker.
    Default(String),
    /// `export { a as b } from './m.js'`.
    From(Source, String),
}

struct Loaded<'a> {
    /// Index into the files: `None` the entry.
    file: Option<usize>,
    stem: String,
    text: &'a str,
    program: Program<'a>,
    scoping: Scoping,
    /// Every specifier this module requests, in source order: imports and re-exports alike.
    requests: Vec<Source>,
    imports: Vec<Import>,
    exports: HashMap<String, Export>,
}

enum Resolved {
    Binding(ModuleId, SymbolId),
    Synthetic(ModuleId),
    External(String, Option<String>),
    Namespace(ModuleId),
}

enum Found {
    Import(Span, String, Vec<(SymbolId, Imported)>),
    Local(String, SymbolId),
    Default(String),
    From(Span, String, String, String),
    Request(Span, String),
}

struct Linker<'a, 'i> {
    allocator: &'a Allocator,
    input: &'i Input<'a>,
    modules: Vec<Loaded<'a>>,
    by_file: HashMap<Option<usize>, ModuleId>,
    problems: Vec<Problem>,
}

/// Bundle the graph reached from the entry.
pub fn bundle(input: &Input<'_>) -> Result<Bundled, Vec<Problem>> {
    let allocator = Allocator::default();
    link(&allocator, input)
}

fn link<'a>(allocator: &'a Allocator, input: &Input<'a>) -> Result<Bundled, Vec<Problem>> {
    // 1–2. Load and order.
    let mut linker = Linker {
        allocator,
        input,
        modules: Vec::new(),
        by_file: HashMap::new(),
        problems: Vec::new(),
    };
    let entry = linker.load(None);
    if !linker.problems.is_empty() {
        return Err(linker.problems);
    }
    let Some(entry) = entry else {
        return Err(linker.problems);
    };
    let order = linker.order(entry);

    // 3. Names. Globals first: no top-level binding may take the name of
    // something any module reads from the global scope.
    let mut names = Names { taken: HashSet::new() };
    for &id in &order {
        for name in linker.modules[id].scoping.root_unresolved_references().keys() {
            names.taken.insert(name.to_string());
        }
    }
    let mut binding_name: HashMap<(ModuleId, SymbolId), String> = HashMap::new();
    let mut synthetic_name: HashMap<ModuleId, String> = HashMap::new();
    for &id in &order {
        let m = &linker.modules[id];
        let root = m.scoping.root_scope_id();
        let mut own: Vec<(String, SymbolId)> = m
            .scoping
            .get_bindings(root)
            .iter()
            .filter(|(_, s)| !m.scoping.symbol_flags(**s).contains(SymbolFlags::Import))
            .map(|(n, s)| (n.to_string(), *s))
            .collect();
        own.sort_by_key(|(_, s)| m.scoping.symbol_span(*s).start);
        for (name, symbol) in own {
            binding_name.insert((id, symbol), names.fresh(&name));
        }
        if let Some(Export::Default(wanted)) = m.exports.get("default") {
            synthetic_name.insert(id, names.fresh(wanted));
        }
    }

    // Import bindings: the name of what each resolves to. A bare import
    // gets one local per (specifier, name); a namespace of our own
    // module, one object. Bare specifiers are listed in the order the
    // modules request them, a side-effect-only import too.
    let mut externals: Vec<(String, Option<String>, String)> = Vec::new();
    let mut bare: Vec<String> = Vec::new();
    let mut namespaces: Vec<(ModuleId, String)> = Vec::new();
    let mut import_name: HashMap<(ModuleId, SymbolId), String> = HashMap::new();
    for &id in &order {
        for request in &linker.modules[id].requests {
            if let Source::External(spec) = request
                && !bare.contains(spec)
            {
                bare.push(spec.clone());
            }
        }
        for import in &linker.modules[id].imports {
            let resolved = match linker.resolve_symbol(id, import.local, 0) {
                Ok(r) => r,
                Err(p) => {
                    linker.problems.push(p);
                    continue;
                }
            };
            let name = match resolved {
                Resolved::Binding(m, s) => binding_name[&(m, s)].clone(),
                Resolved::Synthetic(m) => synthetic_name[&m].clone(),
                Resolved::Namespace(m) => namespace(&linker, &mut names, &mut namespaces, m),
                Resolved::External(spec, imported) => match externals.iter().find(|(s, i, _)| *s == spec && *i == imported) {
                    Some((_, _, local)) => local.clone(),
                    None => {
                        let local = names.fresh(imported.as_deref().unwrap_or("ns"));
                        externals.push((spec, imported, local.clone()));
                        local
                    }
                },
            };
            import_name.insert((id, import.local), name);
        }
    }
    // A namespace object reads its module's exports through getters, so
    // the bindings stay live. A namespace re-exporting another module's
    // namespace makes that one too, so the list grows as it is read.
    let mut namespace_text = String::new();
    let mut i = 0;
    while i < namespaces.len() {
        let (m, local) = namespaces[i].clone();
        let module = &linker.modules[m];
        let mut keys: Vec<&String> = module.exports.keys().collect();
        keys.sort();
        let mut getters = Vec::new();
        for key in keys {
            let target = match linker.resolve_export(m, key, 0) {
                Ok(Resolved::Binding(bm, s)) => binding_name[&(bm, s)].clone(),
                Ok(Resolved::Synthetic(bm)) => synthetic_name[&bm].clone(),
                Ok(Resolved::Namespace(nm)) => namespace(&linker, &mut names, &mut namespaces, nm),
                Ok(Resolved::External(spec, _)) => {
                    linker.problems.push(Problem {
                        file: module.file,
                        at: None,
                        message: format!(
                            "a namespace import of `{}` reaches `{key}`, which it re-exports from the bare specifier \
                             `{spec}`: a namespace of a bundled module holds the bundle's own bindings; import \
                             `{key}` from `{spec}` where it is used",
                            module.stem
                        ),
                    });
                    continue;
                }
                Err(p) => {
                    linker.problems.push(p);
                    continue;
                }
            };
            getters.push(format!("get {key}() {{ return {target}; }}"));
        }
        namespace_text.push_str(&format!(
            "const {local} = Object.freeze({{ __proto__: null, {} }});\n",
            getters.join(", ")
        ));
        i += 1;
    }
    if !linker.problems.is_empty() {
        return Err(linker.problems);
    }

    // 4. Emit, module by module, each with its map.
    let ast = AstBuilder::new(allocator);
    let mut linked = String::new();
    for spec in &bare {
        let mut any = false;
        for (s, imported, local) in &externals {
            if s != spec {
                continue;
            }
            any = true;
            match imported.as_deref() {
                None => linked.push_str(&format!("import * as {local} from {spec:?};\n")),
                Some("default") => linked.push_str(&format!("import {local} from {spec:?};\n")),
                Some(n) => linked.push_str(&format!("import {{ {n} as {local} }} from {spec:?};\n")),
            }
        }
        if !any {
            linked.push_str(&format!("import {spec:?};\n"));
        }
    }
    linked.push_str(&namespace_text);
    let mut maps: Vec<(SourceMap<'static>, u32)> = Vec::new();
    let mut reached: Vec<EntryId> = Vec::new();
    let mut loaded: Vec<Option<Loaded>> = std::mem::take(&mut linker.modules).into_iter().map(Some).collect();
    for &id in &order {
        let mut module = loaded[id].take().expect("each module is emitted once");
        if let Some(i) = module.file {
            reached.push(input.modules[i].id.clone());
        }
        let root = module.scoping.root_scope_id();
        let mut renamed: HashSet<String> = HashSet::new();
        let symbols: Vec<SymbolId> = module.scoping.get_bindings(root).values().copied().collect();
        for symbol in symbols {
            let original = module.scoping.symbol_name(symbol).to_string();
            let name = binding_name
                .get(&(id, symbol))
                .or_else(|| import_name.get(&(id, symbol)))
                .cloned()
                .unwrap_or_else(|| original.clone());
            if name != original {
                renamed.insert(name.clone());
            }
            module.scoping.set_symbol_name(symbol, allocator.alloc_str(&name).into());
        }
        // A nested binding that now shadows a renamed top-level name would
        // capture its references: it moves out of the way, to a name no
        // binding of the module and no top-level name of the bundle has.
        let nested: Vec<SymbolId> = module
            .scoping
            .symbol_ids()
            .filter(|s| module.scoping.symbol_scope_id(*s) != root && renamed.contains(module.scoping.symbol_name(*s)))
            .collect();
        if !nested.is_empty() {
            let own: Vec<String> = module
                .scoping
                .symbol_ids()
                .map(|s| module.scoping.symbol_name(s).to_string())
                .collect();
            names.taken.extend(own);
            for symbol in nested {
                let name = names.fresh(&format!("{}_local", module.scoping.symbol_name(symbol)));
                module.scoping.set_symbol_name(symbol, allocator.alloc_str(&name).into());
            }
        }
        // Drop imports, strip `export`.
        let synthetic = synthetic_name.get(&id).map(|n| allocator.alloc_str(n) as &str);
        let body = std::mem::replace(&mut module.program.body, AVec::new_in(&allocator));
        let mut kept: AVec<Statement> = AVec::new_in(&allocator);
        for stmt in body {
            match stmt {
                Statement::ImportDeclaration(_) => {}
                Statement::ExportDeclaration(d) => kept.push(Statement::from(d.unbox().declaration)),
                Statement::ExportNamedDeclaration(_) | Statement::ExportFromDeclaration(_) => {}
                Statement::ExportDefaultDeclaration(d) => {
                    let name = synthetic.expect("an anonymous default is named");
                    match d.unbox().declaration {
                        ExportDefaultDeclarationKind::FunctionDeclaration(mut f) => {
                            if f.id.is_none() {
                                f.id = Some(BindingIdentifier::new(SPAN, name, &ast));
                            }
                            kept.push(Statement::FunctionDeclaration(f));
                        }
                        ExportDefaultDeclarationKind::ClassDeclaration(mut c) => {
                            if c.id.is_none() {
                                c.id = Some(BindingIdentifier::new(SPAN, name, &ast));
                            }
                            kept.push(Statement::ClassDeclaration(c));
                        }
                        kind => {
                            let span = kind.span();
                            let expr = kind.into_expression();
                            let binding = BindingPattern::BindingIdentifier(BindingIdentifier::boxed(SPAN, name, &ast));
                            let declarator = VariableDeclarator::new(span, binding, None, Some(expr), false, &ast);
                            kept.push(Statement::VariableDeclaration(VariableDeclaration::boxed(
                                span,
                                VariableDeclarationKind::Const,
                                AVec::from_iter_in([declarator], &allocator),
                                false,
                                &ast,
                            )));
                        }
                    }
                }
                other => kept.push(other),
            }
        }
        module.program.body = kept;
        let file_name = match module.file {
            Some(i) => input.modules[i].name.clone(),
            None => input.entry.name.clone(),
        };
        let mut options = CodegenOptions::default();
        if input.source_map {
            options.source_map_path = Some(file_name.into());
        }
        let out = Codegen::new()
            .with_options(options)
            .with_source_text(module.text)
            .with_scoping(Some(module.scoping))
            .build(&module.program);
        if !linked.ends_with('\n') && !linked.is_empty() {
            linked.push('\n');
        }
        let line = linked.matches('\n').count() as u32;
        if let Some(map) = out.map {
            maps.push((map.into_owned(), line));
        }
        linked.push_str(&out.code);
    }

    // 5. Shake and minify the concatenation as one module.
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, &linked, SourceType::mjs()).parse();
    if let Some(d) = parsed.diagnostics.first() {
        return Err(vec![Problem {
            file: None,
            at: None,
            message: format!("the linked bundle does not parse (a linker bug): {}", d.message),
        }]);
    }
    let mut program = parsed.program;
    let options = MinifierOptions {
        mangle: Some(MangleOptions {
            top_level: Some(true),
            ..MangleOptions::default()
        }),
        mangle_properties: None,
        compress: Some(CompressOptions::smallest()),
    };
    let ret = Minifier::new(options).minify(&allocator, &mut program);
    let mut options = CodegenOptions::minify();
    if input.source_map {
        options.source_map_path = Some("linked.js".into());
    }
    let out = Codegen::new().with_options(options).with_scoping(ret.scoping).build(&program);
    let map = match out.map {
        Some(minified) if input.source_map => {
            let concatenated = ConcatSourceMapBuilder::from_owned_sourcemaps(maps).into_sourcemap();
            let mut composed = minified.compose(concatenated);
            composed.set_file(&format!("{}.js", input.entry.id));
            Some(composed.to_json_string())
        }
        _ => None,
    };
    Ok(Bundled {
        code: out.code,
        map,
        facts: BundleFacts {
            modules: reached,
            imports: bare,
        },
    })
}

/// The namespace object of module `m`, made once.
fn namespace(linker: &Linker<'_, '_>, names: &mut Names, namespaces: &mut Vec<(ModuleId, String)>, m: ModuleId) -> String {
    if let Some((_, local)) = namespaces.iter().find(|(n, _)| *n == m) {
        return local.clone();
    }
    let local = names.fresh(&format!("{}_ns", linker.modules[m].stem));
    namespaces.push((m, local.clone()));
    local
}

impl<'a> Linker<'a, '_> {
    fn text(&self, file: Option<usize>) -> &'a str {
        match file {
            Some(i) => self.input.modules[i].text,
            None => self.input.entry.text,
        }
    }

    fn problem(&mut self, file: Option<usize>, offset: Option<u32>, message: String) {
        let at = offset.map(|o| position(self.text(file), o as usize));
        self.problems.push(Problem { file, at, message });
    }

    /// Parse, erase and scan one file, once. `None` when it cannot be
    /// read as a module (the problem is recorded).
    fn load(&mut self, file: Option<usize>) -> Option<ModuleId> {
        if let Some(&id) = self.by_file.get(&file) {
            return Some(id);
        }
        let (id_name, name) = match file {
            Some(i) => (&self.input.modules[i].id, &self.input.modules[i].name),
            None => (&self.input.entry.id, &self.input.entry.name),
        };
        let stem = match file {
            Some(_) => id_name.0.replace(|c: char| !c.is_ascii_alphanumeric(), "_"),
            None => "entry".to_string(),
        };
        let text = self.text(file);
        let allocator = self.allocator;
        let source_type = SourceType::ts().with_module(true);
        let parsed = Parser::new(allocator, text, source_type).parse();
        if !parsed.diagnostics.is_empty() {
            for d in &parsed.diagnostics {
                let offset = d.labels.first().map(|l| l.offset());
                self.problem(file, offset, d.message.to_string());
            }
            return None;
        }
        let mut program = parsed.program;
        let scoping = SemanticBuilder::new().build(&program).semantic.into_scoping();
        let options = TransformOptions::default();
        let ret = Transformer::new(allocator, std::path::Path::new(name), &options).build_with_scoping(scoping, &mut program);
        if !ret.diagnostics.is_empty() {
            for d in &ret.diagnostics {
                let offset = d.labels.first().map(|l| l.offset());
                self.problem(file, offset, d.message.to_string());
            }
            return None;
        }
        // The erased program's own scoping: the imports erasure elided
        // (type-only uses) are gone from it.
        let scoping = SemanticBuilder::new().build(&program).semantic.into_scoping();
        let id = self.modules.len();
        self.by_file.insert(file, id);
        self.modules.push(Loaded {
            file,
            stem,
            text,
            program,
            scoping,
            requests: Vec::new(),
            imports: Vec::new(),
            exports: HashMap::new(),
        });
        self.dynamic_imports(file, id);
        self.scan(id);
        Some(id)
    }

    /// A literal `import()` of a bundled module has nothing to load: the
    /// bundle is one file, with no `./{id}.js` beside it.
    fn dynamic_imports(&mut self, file: Option<usize>, id: ModuleId) {
        let text = self.modules[id].text;
        let mut found = Vec::new();
        // The parser's module record holds every `import()`; the erased
        // program kept them all, so the source's record is the program's.
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, text, SourceType::ts().with_module(true)).parse();
        for dynamic in &parsed.module_record.dynamic_imports {
            let span = dynamic.module_request;
            let written = &text[span.start as usize..span.end as usize];
            if let Some(literal) = string_literal(written)
                && relative(&literal)
            {
                found.push((span.start, literal));
            }
        }
        for (offset, literal) in found {
            self.problem(
                file,
                Some(offset),
                format!(
                    "imports `{literal}` dynamically: a bundle is one file, with no `{literal}` beside it to load at \
                     run time; import the module statically (the bundle keeps what it uses)"
                ),
            );
        }
    }

    /// What a relative specifier of `file` names: a bundled module, by id.
    /// A module's specifiers were held to the layout by the import check
    /// (`./{id}.js`, its source beside); the entry has no directory, so its
    /// relative specifiers are ids alone.
    fn source(&mut self, file: Option<usize>, at: Span, specifier: &str) -> Option<Source> {
        if !relative(specifier) {
            if file.is_none() && !self.input.declared.contains(specifier) {
                self.problem(
                    file,
                    Some(at.start),
                    format!(
                        "imports `{specifier}`, which no declarations entry of the manifest declares (`declare module \
                         \"{specifier}\"`)"
                    ),
                );
                return None;
            }
            return Some(Source::External(specifier.to_string()));
        }
        let target = specifier
            .strip_prefix("./")
            .and_then(|s| s.strip_suffix(".js"))
            .and_then(|id| self.input.modules.iter().position(|m| m.id.0 == id));
        let Some(target) = target else {
            let ids: Vec<String> = self.input.modules.iter().map(|m| format!("`./{}.js`", m.id)).collect();
            self.problem(
                file,
                Some(at.start),
                format!(
                    "imports `{specifier}`, which is not a module of this bundle: the entry names a bundled module by \
                     its id, as `./{{id}}.js` (this bundle's: {})",
                    if ids.is_empty() { "none".to_string() } else { ids.join(", ") }
                ),
            );
            return None;
        };
        self.load(Some(target)).map(Source::Module)
    }

    fn found(&mut self, id: ModuleId) -> Vec<Found> {
        let m = &self.modules[id];
        let file = m.file;
        let root = m.scoping.root_scope_id();
        let mut found = Vec::new();
        let mut problems: Vec<(Option<u32>, String)> = Vec::new();
        let local = |name: &str, at: Span, problems: &mut Vec<(Option<u32>, String)>| {
            let symbol = m.scoping.get_binding(root, name.into());
            if symbol.is_none() {
                problems.push((Some(at.start), format!("exports `{name}`, which the module does not declare")));
            }
            symbol
        };
        let is_entry = file.is_none();
        for stmt in &m.program.body {
            if is_entry
                && matches!(
                    stmt,
                    Statement::ExportDeclaration(_)
                        | Statement::ExportNamedDeclaration(_)
                        | Statement::ExportFromDeclaration(_)
                        | Statement::ExportDefaultDeclaration(_)
                        | Statement::ExportAllDeclaration(_)
                )
            {
                problems.push((
                    Some(stmt.span().start),
                    "the entry exports: nothing imports a bundle, so an entry is a program and exports nothing".to_string(),
                ));
                continue;
            }
            match stmt {
                Statement::ImportDeclaration(d) => {
                    let mut specifiers = Vec::new();
                    for s in d.specifiers.iter().flatten() {
                        specifiers.push(match s {
                            ImportDeclarationSpecifier::ImportSpecifier(s) => {
                                (s.local.symbol_id(), Imported::Name(s.imported.name().to_string()))
                            }
                            ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => (s.local.symbol_id(), Imported::Default),
                            ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => (s.local.symbol_id(), Imported::Namespace),
                        });
                    }
                    found.push(Found::Import(d.source.span, js(d.source.value), specifiers));
                }
                Statement::ExportDeclaration(d) => {
                    for name in declared_names(&d.declaration) {
                        if let Some(symbol) = local(&name, d.span, &mut problems) {
                            found.push(Found::Local(name, symbol));
                        }
                    }
                }
                Statement::ExportNamedDeclaration(d) => {
                    for s in &d.specifiers {
                        if let Some(symbol) = local(&s.local.name(), s.span, &mut problems) {
                            found.push(Found::Local(s.exported.name().to_string(), symbol));
                        }
                    }
                }
                Statement::ExportFromDeclaration(d) => {
                    let spec = js(d.source.value);
                    for s in &d.specifiers {
                        found.push(Found::From(
                            d.source.span,
                            spec.clone(),
                            s.local.name().to_string(),
                            s.exported.name().to_string(),
                        ));
                    }
                    if d.specifiers.is_empty() {
                        found.push(Found::Request(d.source.span, spec));
                    }
                }
                Statement::ExportDefaultDeclaration(d) => match &d.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(f) if f.id.is_some() => {
                        found.push(Found::Local("default".into(), f.id.as_ref().expect("named").symbol_id()))
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(c) if c.id.is_some() => {
                        found.push(Found::Local("default".into(), c.id.as_ref().expect("named").symbol_id()))
                    }
                    _ => found.push(Found::Default(format!("{}_default", m.stem))),
                },
                Statement::ExportAllDeclaration(d) => {
                    let spec = js(d.source.value);
                    let form = match &d.exported {
                        Some(name) => format!(
                            "`export * as {} from '{spec}'`: import it as a namespace (`import * as {} from '{spec}'`) \
                             and export that binding",
                            name.name(),
                            name.name()
                        ),
                        None => format!("`export * from '{spec}'`: re-export each name (`export {{ a, b }} from '{spec}'`)"),
                    };
                    problems.push((
                        Some(d.span.start),
                        format!("{form}; a bundle links the names a module exports by name, and `export *` is not linked"),
                    ));
                }
                _ => {}
            }
        }
        for (offset, message) in problems {
            self.problem(file, offset, message);
        }
        found
    }

    fn scan(&mut self, id: ModuleId) {
        let file = self.modules[id].file;
        for f in self.found(id) {
            match f {
                Found::Import(at, spec, specifiers) => {
                    let Some(request) = self.source(file, at, &spec) else { continue };
                    for (local, imported) in specifiers {
                        self.modules[id].imports.push(Import {
                            local,
                            from: request.clone(),
                            imported,
                        });
                    }
                    self.modules[id].requests.push(request);
                }
                Found::Local(name, symbol) => {
                    self.modules[id].exports.insert(name, Export::Local(symbol));
                }
                Found::Default(name) => {
                    self.modules[id].exports.insert("default".into(), Export::Default(name));
                }
                Found::From(at, spec, inner, exported) => {
                    let Some(request) = self.source(file, at, &spec) else { continue };
                    self.modules[id].requests.push(request.clone());
                    self.modules[id].exports.insert(exported, Export::From(request, inner));
                }
                Found::Request(at, spec) => {
                    let Some(request) = self.source(file, at, &spec) else { continue };
                    self.modules[id].requests.push(request);
                }
            }
        }
    }

    /// What `name` exported by module `id` finally is.
    fn resolve_export(&self, id: ModuleId, name: &str, depth: usize) -> Result<Resolved, Problem> {
        let m = &self.modules[id];
        if depth > 64 {
            return Err(Problem {
                file: m.file,
                at: None,
                message: format!("`{name}` is re-exported in a circle and never declared"),
            });
        }
        match m.exports.get(name) {
            None => Err(Problem {
                file: m.file,
                at: None,
                message: format!("`{}` does not export `{name}`, which another module of the bundle imports", m.stem),
            }),
            Some(Export::Default(_)) => Ok(Resolved::Synthetic(id)),
            Some(Export::Local(symbol)) => self.resolve_symbol(id, *symbol, depth + 1),
            Some(Export::From(Source::Module(target), inner)) => self.resolve_export(*target, inner, depth + 1),
            Some(Export::From(Source::External(spec), inner)) => Ok(Resolved::External(spec.clone(), Some(inner.clone()))),
        }
    }

    /// A module's own binding, followed through its import when it is an import binding.
    fn resolve_symbol(&self, id: ModuleId, symbol: SymbolId, depth: usize) -> Result<Resolved, Problem> {
        let m = &self.modules[id];
        if !m.scoping.symbol_flags(symbol).contains(SymbolFlags::Import) {
            return Ok(Resolved::Binding(id, symbol));
        }
        let Some(import) = m.imports.iter().find(|i| i.local == symbol) else {
            return Err(Problem {
                file: m.file,
                at: None,
                message: format!("the import `{}` was not resolved", m.scoping.symbol_name(symbol)),
            });
        };
        match (&import.from, &import.imported) {
            (Source::Module(target), Imported::Name(n)) => self.resolve_export(*target, n, depth + 1),
            (Source::Module(target), Imported::Default) => self.resolve_export(*target, "default", depth + 1),
            (Source::Module(target), Imported::Namespace) => Ok(Resolved::Namespace(*target)),
            (Source::External(spec), Imported::Name(n)) => Ok(Resolved::External(spec.clone(), Some(n.clone()))),
            (Source::External(spec), Imported::Default) => Ok(Resolved::External(spec.clone(), Some("default".into()))),
            (Source::External(spec), Imported::Namespace) => Ok(Resolved::External(spec.clone(), None)),
        }
    }

    fn order(&self, entry: ModuleId) -> Vec<ModuleId> {
        fn visit(l: &Linker, id: ModuleId, state: &mut Vec<u8>, out: &mut Vec<ModuleId>) {
            if state[id] != 0 {
                return;
            }
            state[id] = 1;
            for r in &l.modules[id].requests {
                if let Source::Module(dep) = r {
                    visit(l, *dep, state, out);
                }
            }
            state[id] = 2;
            out.push(id);
        }
        let mut state = vec![0; self.modules.len()];
        let mut out = Vec::new();
        visit(self, entry, &mut state, &mut out);
        out
    }
}

/// A specifier as written; a lone surrogate (which no file name has)
/// reads as the replacement character and so resolves to nothing.
fn js(s: oxc::str::JSStr) -> String {
    match s.as_str() {
        Some(s) => s.to_string(),
        None => "\u{fffd}".to_string(),
    }
}

fn relative(specifier: &str) -> bool {
    specifier.starts_with("./") || specifier.starts_with("../")
}

/// The contents of a quoted string literal with no escapes, as written.
fn string_literal(written: &str) -> Option<String> {
    let quote = written.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let inner = written.strip_prefix(quote)?.strip_suffix(quote)?;
    (!inner.contains('\\') && !inner.contains(quote)).then(|| inner.to_string())
}

fn declared_names(decl: &Declaration) -> Vec<String> {
    match decl {
        Declaration::VariableDeclaration(v) => v
            .declarations
            .iter()
            .flat_map(|d| d.id.get_binding_identifiers().into_iter().map(|b| b.name.to_string()))
            .collect(),
        Declaration::FunctionDeclaration(f) => f.id.iter().map(|i| i.name.to_string()).collect(),
        Declaration::ClassDeclaration(c) => c.id.iter().map(|i| i.name.to_string()).collect(),
        _ => Vec::new(),
    }
}

struct Names {
    taken: HashSet<String>,
}

impl Names {
    fn fresh(&mut self, wanted: &str) -> String {
        let mut name = wanted.to_string();
        let mut n = 1;
        while self.taken.contains(&name) {
            name = format!("{wanted}${n}");
            n += 1;
        }
        self.taken.insert(name.clone());
        name
    }
}
