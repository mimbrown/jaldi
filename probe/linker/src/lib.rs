//! Probe (#754): a linker of our own over oxc.
//!
//! Scope hoisting the way rollup does it, for the one graph shape we have:
//! relative imports among our own ESM modules under the entry's directory,
//! bare specifiers (the import map's `vendor/…`, `pattern/…`, `app/…`) left
//! as imports, `import()` left alone, no CommonJS, no `export *`.
//!
//! 1. Load: parse each module reached from the entry, with its scoping.
//! 2. Order: ESM evaluation order — depth-first post-order over each
//!    module's requests in source order, a module in progress skipped (a
//!    cycle evaluates the way the browser would evaluate it).
//! 3. Name: every top-level binding gets one name unique across the
//!    bundle and distinct from every global any module reads; an import
//!    binding takes the name of what it resolves to; a nested binding
//!    that a rename would capture is renamed out of the way.
//! 4. Emit: each module printed with its imports dropped and `export`
//!    stripped (an anonymous default gets a name), concatenated in order,
//!    the external imports hoisted to the top.
//! 5. Shake: the concatenation re-parsed as one module and handed to oxc's
//!    minifier, which drops what nothing references and keeps every
//!    statement that may have an effect.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use oxc::allocator::{Allocator, Vec as AVec};
use oxc::ast::ast::*;
use oxc::ast::builder::AstBuilder;
use oxc::codegen::{Codegen, CodegenOptions};
use oxc::mangler::MangleOptions;
use oxc::minifier::{CompressOptions, Minifier, MinifierOptions};
use oxc::parser::Parser;
use oxc::semantic::{Scoping, SemanticBuilder, SymbolFlags, SymbolId};
use oxc::span::{SPAN, SourceType};

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

struct Module<'a> {
    path: PathBuf,
    stem: String,
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

struct Linker<'a> {
    allocator: &'a Allocator,
    root: PathBuf,
    modules: Vec<Module<'a>>,
    by_path: HashMap<PathBuf, ModuleId>,
}

fn fail(message: String) -> ! {
    eprintln!("error: {message}");
    std::process::exit(1);
}

enum Found {
    Import(String, Vec<(SymbolId, Imported)>),
    Local(String, SymbolId),
    Default(String),
    From(String, String, String),
    Request(String),
}

impl<'a> Linker<'a> {
    fn load(&mut self, path: PathBuf) -> ModuleId {
        if let Some(&id) = self.by_path.get(&path) {
            return id;
        }
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| fail(format!("{}: {e}", path.display())));
        let text = self.allocator.alloc_str(&text);
        let parsed = Parser::new(self.allocator, text, SourceType::mjs()).parse();
        if !parsed.diagnostics.is_empty() {
            fail(format!("{}: {}", path.display(), parsed.diagnostics[0].message));
        }
        let program = parsed.program;
        let scoping = SemanticBuilder::new().build(&program).semantic.into_scoping();
        let id = self.modules.len();
        self.by_path.insert(path.clone(), id);
        let stem = path
            .file_stem()
            .unwrap()
            .to_string_lossy()
            .replace(|c: char| !c.is_ascii_alphanumeric(), "_");
        self.modules.push(Module {
            path,
            stem,
            program,
            scoping,
            requests: Vec::new(),
            imports: Vec::new(),
            exports: HashMap::new(),
        });
        self.scan(id);
        id
    }

    fn source(&mut self, from: &Path, specifier: &str) -> Source {
        if !(specifier.starts_with("./") || specifier.starts_with("../")) {
            return Source::External(specifier.to_string());
        }
        let path = from
            .parent()
            .unwrap()
            .join(specifier)
            .canonicalize()
            .unwrap_or_else(|e| fail(format!("{}: `{specifier}` does not resolve: {e}", from.display())));
        if !path.starts_with(&self.root) {
            fail(format!("{}: `{specifier}` resolves outside the root", from.display()));
        }
        Source::Module(self.load(path))
    }

    fn found(&self, id: ModuleId) -> Vec<Found> {
        let m = &self.modules[id];
        let root = m.scoping.root_scope_id();
        let local = |name: &str| {
            m.scoping
                .get_binding(root, name.into())
                .unwrap_or_else(|| fail(format!("{}: `{name}` is exported but not declared", m.path.display())))
        };
        let mut found = Vec::new();
        for stmt in &m.program.body {
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
                    found.push(Found::Import(js(d.source.value), specifiers));
                }
                Statement::ExportDeclaration(d) => {
                    for name in declared_names(&d.declaration) {
                        let symbol = local(&name);
                        found.push(Found::Local(name, symbol));
                    }
                }
                Statement::ExportNamedDeclaration(d) => {
                    for s in &d.specifiers {
                        found.push(Found::Local(s.exported.name().to_string(), local(&s.local.name())));
                    }
                }
                Statement::ExportFromDeclaration(d) => {
                    for s in &d.specifiers {
                        found.push(Found::From(
                            js(d.source.value),
                            s.local.name().to_string(),
                            s.exported.name().to_string(),
                        ));
                    }
                    if d.specifiers.is_empty() {
                        found.push(Found::Request(js(d.source.value)));
                    }
                }
                Statement::ExportDefaultDeclaration(d) => match &d.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(f) if f.id.is_some() => {
                        found.push(Found::Local("default".into(), f.id.as_ref().unwrap().symbol_id()))
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(c) if c.id.is_some() => {
                        found.push(Found::Local("default".into(), c.id.as_ref().unwrap().symbol_id()))
                    }
                    _ => found.push(Found::Default(format!("{}_default", m.stem))),
                },
                Statement::ExportAllDeclaration(_) => fail(format!("{}: `export *` is outside the probe's graph shape", m.path.display())),
                _ => {}
            }
        }
        found
    }

    fn scan(&mut self, id: ModuleId) {
        let path = self.modules[id].path.clone();
        for f in self.found(id) {
            match f {
                Found::Import(spec, specifiers) => {
                    let request = self.source(&path, &spec);
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
                Found::From(spec, inner, exported) => {
                    let request = self.source(&path, &spec);
                    self.modules[id].requests.push(request.clone());
                    self.modules[id].exports.insert(exported, Export::From(request, inner));
                }
                Found::Request(spec) => {
                    let request = self.source(&path, &spec);
                    self.modules[id].requests.push(request);
                }
            }
        }
    }

    /// What `name` exported by module `id` finally is.
    fn resolve_export(&self, id: ModuleId, name: &str, depth: usize) -> Resolved {
        if depth > 64 {
            fail(format!("{}: `{name}` is a circular re-export", self.modules[id].path.display()));
        }
        let m = &self.modules[id];
        match m.exports.get(name) {
            None => fail(format!("{} does not export `{name}`", m.path.display())),
            Some(Export::Default(_)) => Resolved::Synthetic(id),
            Some(Export::Local(symbol)) => self.resolve_symbol(id, *symbol, depth + 1),
            Some(Export::From(Source::Module(target), inner)) => self.resolve_export(*target, inner, depth + 1),
            Some(Export::From(Source::External(spec), inner)) => Resolved::External(spec.clone(), Some(inner.clone())),
        }
    }

    /// A module's own binding, followed through its import when it is an import binding.
    fn resolve_symbol(&self, id: ModuleId, symbol: SymbolId, depth: usize) -> Resolved {
        let m = &self.modules[id];
        if !m.scoping.symbol_flags(symbol).contains(SymbolFlags::Import) {
            return Resolved::Binding(id, symbol);
        }
        let import = m
            .imports
            .iter()
            .find(|i| i.local == symbol)
            .expect("an import binding has its import");
        match (&import.from, &import.imported) {
            (Source::Module(target), Imported::Name(n)) => self.resolve_export(*target, n, depth + 1),
            (Source::Module(target), Imported::Default) => self.resolve_export(*target, "default", depth + 1),
            (Source::Module(target), Imported::Namespace) => Resolved::Namespace(*target),
            (Source::External(spec), Imported::Name(n)) => Resolved::External(spec.clone(), Some(n.clone())),
            (Source::External(spec), Imported::Default) => Resolved::External(spec.clone(), Some("default".into())),
            (Source::External(spec), Imported::Namespace) => Resolved::External(spec.clone(), None),
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

fn js(s: oxc::str::JSStr) -> String {
    s.as_str()
        .unwrap_or_else(|| fail("a specifier with a lone surrogate".into()))
        .to_string()
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

/// What the bundle is printed as.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Linked and nothing else: every statement of every module in the graph.
    Linked,
    /// Dead code dropped, names and layout kept.
    Shaken,
    /// Shaken, compressed and mangled.
    Minified,
}

/// Bundle the graph reached from `entry`. A refusal exits the process (probe).
pub fn bundle(entry: &Path, mode: Mode) -> String {
    let entry_path = entry.canonicalize().expect("entry");
    let minify = mode != Mode::Linked;
    let shake_only = mode == Mode::Shaken;

    // 1–2. Load and order.
    let allocator = Allocator::default();
    let mut linker = Linker {
        allocator: &allocator,
        root: entry_path.parent().unwrap().to_path_buf(),
        modules: Vec::new(),
        by_path: HashMap::new(),
    };
    let entry = linker.load(entry_path);
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
    // Import bindings: the name of what each resolves to. External imports
    // get one local per (specifier, name); a namespace of our own module, one object.
    let mut externals: Vec<(String, Option<String>, String)> = Vec::new();
    let mut namespaces: HashMap<ModuleId, String> = HashMap::new();
    let mut import_name: HashMap<(ModuleId, SymbolId), String> = HashMap::new();
    for &id in &order {
        for import in &linker.modules[id].imports {
            let name = match linker.resolve_symbol(id, import.local, 0) {
                Resolved::Binding(m, s) => binding_name[&(m, s)].clone(),
                Resolved::Synthetic(m) => synthetic_name[&m].clone(),
                Resolved::Namespace(m) => namespaces
                    .entry(m)
                    .or_insert_with(|| names.fresh(&format!("{}_ns", linker.modules[m].stem)))
                    .clone(),
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
    // A namespace object reads its module's exports through getters, so the bindings stay live.
    let mut namespace_text: HashMap<ModuleId, String> = HashMap::new();
    for (&m, local) in &namespaces {
        let module = &linker.modules[m];
        let mut keys: Vec<&String> = module.exports.keys().collect();
        keys.sort();
        let getters: Vec<String> = keys
            .into_iter()
            .map(|key| {
                let target = match linker.resolve_export(m, key, 0) {
                    Resolved::Binding(bm, s) => binding_name[&(bm, s)].clone(),
                    Resolved::Synthetic(bm) => synthetic_name[&bm].clone(),
                    _ => fail(format!("{}: a namespace over `{key}` is outside the probe", module.path.display())),
                };
                format!("get {key}() {{ return {target}; }}")
            })
            .collect();
        namespace_text.insert(
            m,
            format!("const {local} = Object.freeze({{ __proto__: null, {} }});\n", getters.join(", ")),
        );
    }

    // 4. Emit, module by module.
    let ast = AstBuilder::new(&allocator);
    let mut bundle = String::new();
    for (spec, imported, local) in &externals {
        match imported.as_deref() {
            None => bundle.push_str(&format!("import * as {local} from {spec:?};\n")),
            Some("default") => bundle.push_str(&format!("import {local} from {spec:?};\n")),
            Some(n) => bundle.push_str(&format!("import {{ {n} as {local} }} from {spec:?};\n")),
        }
    }
    let root_dir = linker.root.clone();
    let mut modules: Vec<Option<Module>> = std::mem::take(&mut linker.modules).into_iter().map(Some).collect();
    for &id in &order {
        let mut module = modules[id].take().unwrap();
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
        // A nested binding that now shadows a renamed top-level name would capture its references.
        let nested: Vec<SymbolId> = module
            .scoping
            .symbol_ids()
            .filter(|s| module.scoping.symbol_scope_id(*s) != root && renamed.contains(module.scoping.symbol_name(*s)))
            .collect();
        for symbol in nested {
            let name = names.fresh(&format!("{}_local", module.scoping.symbol_name(symbol)));
            module.scoping.set_symbol_name(symbol, allocator.alloc_str(&name).into());
        }
        // Drop imports, strip `export`.
        let synthetic = synthetic_name.get(&id).map(|n| allocator.alloc_str(n) as &str);
        let body = std::mem::replace(&mut module.program.body, AVec::new_in(&&allocator));
        let mut kept: AVec<Statement> = AVec::new_in(&&allocator);
        for stmt in body {
            match stmt {
                Statement::ImportDeclaration(_) => {}
                Statement::ExportDeclaration(d) => kept.push(Statement::from(d.unbox().declaration)),
                Statement::ExportNamedDeclaration(_) | Statement::ExportFromDeclaration(_) => {}
                Statement::ExportDefaultDeclaration(d) => match d.unbox().declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(mut f) => {
                        if f.id.is_none() {
                            f.id = Some(BindingIdentifier::new(SPAN, synthetic.unwrap(), &ast));
                        }
                        kept.push(Statement::FunctionDeclaration(f));
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(mut c) => {
                        if c.id.is_none() {
                            c.id = Some(BindingIdentifier::new(SPAN, synthetic.unwrap(), &ast));
                        }
                        kept.push(Statement::ClassDeclaration(c));
                    }
                    kind => {
                        let expr = kind.into_expression();
                        let binding = BindingPattern::BindingIdentifier(BindingIdentifier::boxed(SPAN, synthetic.unwrap(), &ast));
                        let declarator = VariableDeclarator::new(SPAN, binding, None, Some(expr), false, &ast);
                        kept.push(Statement::VariableDeclaration(VariableDeclaration::boxed(
                            SPAN,
                            VariableDeclarationKind::Const,
                            AVec::from_iter_in([declarator], &&allocator),
                            false,
                            &ast,
                        )));
                    }
                },
                other => kept.push(other),
            }
        }
        module.program.body = kept;
        let code = Codegen::new()
            .with_options(CodegenOptions::default())
            .with_scoping(Some(module.scoping))
            .build(&module.program)
            .code;
        bundle.push_str(&format!("// {}\n", module.path.strip_prefix(&root_dir).unwrap().display()));
        bundle.push_str(&code);
        if let Some(ns) = namespace_text.get(&id) {
            bundle.push_str(ns);
        }
    }

    // 5. Shake and minify the concatenation as one module.
    if minify {
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, &bundle, SourceType::mjs()).parse();
        if !parsed.diagnostics.is_empty() {
            fail(format!("the linked bundle does not parse: {}", parsed.diagnostics[0].message));
        }
        let mut program = parsed.program;
        if shake_only {
            let options = MinifierOptions {
                mangle: None,
                mangle_properties: None,
                compress: Some(CompressOptions::dce()),
            };
            let ret = Minifier::new(options).dce(&allocator, &mut program);
            Codegen::new().with_scoping(ret.scoping).build(&program).code
        } else {
            let options = MinifierOptions {
                mangle: Some(MangleOptions {
                    top_level: Some(true),
                    ..MangleOptions::default()
                }),
                mangle_properties: None,
                compress: Some(CompressOptions::smallest()),
            };
            let ret = Minifier::new(options).minify(&allocator, &mut program);
            Codegen::new()
                .with_options(CodegenOptions::minify())
                .with_scoping(ret.scoping)
                .build(&program)
                .code
        }
    } else {
        bundle
    }
}

/// One module minified on its own, as it would be served unbundled: the
/// baseline a bundle is measured against. Its exports keep their names.
pub fn minify_module(source: &str) -> String {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
    if !parsed.diagnostics.is_empty() {
        fail(format!("does not parse: {}", parsed.diagnostics[0].message));
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
    Codegen::new()
        .with_options(CodegenOptions::minify())
        .with_scoping(ret.scoping)
        .build(&program)
        .code
}
