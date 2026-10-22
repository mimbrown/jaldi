//! Sheets with lightningcss: parsed as the browser reads them, read back
//! as rules for the framework's own checks (before minify, which rewrites
//! values and merges rules), then minified. No browser floor: nothing is
//! lowered, the framework's stance being current stable.

use std::collections::BTreeSet;

use jaldi_contract::{Declaration, Position, Rule, SheetFacts};
use lightningcss::printer::PrinterOptions;
use lightningcss::properties::Property;
use lightningcss::rules::{CssRule, CssRuleList};
use lightningcss::stylesheet::{MinifyOptions, ParserOptions, StyleSheet};
use lightningcss::targets::Targets;
use lightningcss::traits::ToCss;

pub struct Lowered {
    pub css: String,
    pub map: Option<String>,
    pub facts: SheetFacts,
    /// Problems in a sheet that parsed: an undeclared token read.
    pub problems: Vec<(Option<Position>, String)>,
}

pub fn lower(text: &str, name: &str, tokens: &[String], source_map: bool) -> Result<Lowered, (Option<Position>, String)> {
    // CSS error recovery is silent: an unclosed `calc(` in one custom
    // property can swallow everything after it and still parse. So first
    // a bracket balance that names the opener left open, then the parse.
    if let Some((at, message)) = unbalanced(text) {
        return Err((Some(at), message));
    }
    let targets = Targets::default();
    let mut sheet = StyleSheet::parse(
        text,
        ParserOptions {
            filename: name.to_string(),
            ..Default::default()
        },
    )
    .map_err(|e| {
        let at = e.loc.as_ref().map(|l| Position {
            line: l.line + 1,
            column: l.column,
        });
        (at, format!("does not parse: {}", e.kind))
    })?;
    // The facts first: minify rewrites values and merges rules, and the
    // checks read what the author wrote.
    let mut rules = Vec::new();
    let mut declared = BTreeSet::new();
    walk(
        &sheet.rules,
        &Enclosing {
            layer: None,
            selector: None,
            specificity: 0,
            depth: 0,
            conditions: Vec::new(),
        },
        &mut rules,
        &mut declared,
    );
    sheet
        .minify(MinifyOptions {
            targets,
            ..Default::default()
        })
        .map_err(|e| (None, format!("does not lower: {e}")))?;

    let mut map = if source_map {
        let mut m = parcel_sourcemap::SourceMap::new("/");
        let idx = m.add_source(name);
        let _ = m.set_source_content(idx as usize, text);
        Some(m)
    } else {
        None
    };
    let printed = sheet
        .to_css(PrinterOptions {
            minify: true,
            targets,
            source_map: map.as_mut(),
            ..Default::default()
        })
        .map_err(|e| (None, format!("does not print: {e}")))?;
    let map = map.and_then(|mut m| m.to_json(None).ok());

    let mut problems = Vec::new();
    for read in reads(&printed.code) {
        if !tokens.contains(&read) && !declared.contains(&read) {
            problems.push((
                None,
                format!("`var({read})` reads a custom property the composition does not declare"),
            ));
        }
    }
    Ok(Lowered {
        css: printed.code,
        map,
        facts: SheetFacts { rules },
        problems,
    })
}

/// The first bracket left open or closed without an opener, outside
/// strings and comments.
fn unbalanced(text: &str) -> Option<(Position, String)> {
    let mut stack: Vec<(char, usize)> = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        match c {
            '/' if bytes.get(i + 1) == Some(&b'*') => {
                i = text[i + 2..].find("*/").map(|j| i + 2 + j + 2).unwrap_or(bytes.len());
                continue;
            }
            '"' | '\'' => {
                let mut j = i + 1;
                while j < bytes.len() && bytes[j] as char != c {
                    if bytes[j] == b'\\' {
                        j += 1;
                    }
                    j += 1;
                }
                i = j + 1;
                continue;
            }
            '{' | '(' | '[' => stack.push((c, i)),
            '}' | ')' | ']' => {
                let opener = match c {
                    '}' => '{',
                    ')' => '(',
                    _ => '[',
                };
                match stack.pop() {
                    Some((o, _)) if o == opener => {}
                    Some((o, at)) => return Some((crate::erase::position(text, at), format!("`{o}` opened here is closed by `{c}`"))),
                    None => return Some((crate::erase::position(text, i), format!("`{c}` closes nothing"))),
                }
            }
            _ => {}
        }
        i += 1;
    }
    stack
        .last()
        .map(|(o, at)| (crate::erase::position(text, *at), format!("`{o}` is never closed")))
}

/// What encloses a rule being walked.
struct Enclosing {
    layer: Option<String>,
    /// The nearest enclosing style rule's resolved selector.
    selector: Option<String>,
    /// Its packed specificity.
    specificity: u32,
    depth: u32,
    conditions: Vec<String>,
}

impl Enclosing {
    fn under(&self, condition: String) -> Enclosing {
        let mut conditions = self.conditions.clone();
        conditions.push(condition);
        Enclosing {
            layer: self.layer.clone(),
            selector: self.selector.clone(),
            specificity: self.specificity,
            depth: self.depth,
            conditions,
        }
    }
}

fn walk<'i>(list: &CssRuleList<'i>, enclosing: &Enclosing, out: &mut Vec<Rule>, declared: &mut BTreeSet<String>) {
    for rule in &list.0 {
        match rule {
            CssRule::Style(style) => {
                let mut declarations = Vec::new();
                for (important, list) in [
                    (false, &style.declarations.declarations),
                    (true, &style.declarations.important_declarations),
                ] {
                    for p in list {
                        let d = declaration(p, important);
                        if d.name.starts_with("--") {
                            declared.insert(d.name.clone());
                        }
                        declarations.push(d);
                    }
                }
                let at = Position {
                    line: style.loc.line + 1,
                    column: style.loc.column,
                };
                for selector in &style.selectors.0 {
                    let text = selector.to_css_string(PrinterOptions::default()).unwrap_or_default();
                    // Nesting: `&` is the parent; a nested selector with
                    // no `&` is a descendant of it.
                    let resolved = match &enclosing.selector {
                        None => text,
                        Some(parent) if text.contains('&') => text.replace('&', parent),
                        Some(parent) => format!("{parent} {text}"),
                    };
                    let packed = enclosing.specificity + selector.specificity();
                    out.push(Rule {
                        selector: resolved.clone(),
                        layer: enclosing.layer.clone(),
                        specificity: ((packed >> 20) & 0x3ff, (packed >> 10) & 0x3ff, packed & 0x3ff),
                        depth: enclosing.depth,
                        conditions: enclosing.conditions.clone(),
                        declarations: declarations.clone(),
                        at,
                    });
                    walk(
                        &style.rules,
                        &Enclosing {
                            layer: enclosing.layer.clone(),
                            selector: Some(resolved),
                            specificity: packed,
                            depth: enclosing.depth + 1,
                            conditions: enclosing.conditions.clone(),
                        },
                        out,
                        declared,
                    );
                }
            }
            CssRule::LayerBlock(block) => {
                let name = block
                    .name
                    .as_ref()
                    .map(|n| n.to_css_string(PrinterOptions::default()).unwrap_or_default());
                let inner = match (&enclosing.layer, name) {
                    (Some(outer), Some(n)) => Some(format!("{outer}.{n}")),
                    (Some(outer), None) => Some(outer.clone()),
                    (None, n) => n,
                };
                let under = Enclosing {
                    layer: inner,
                    selector: enclosing.selector.clone(),
                    specificity: enclosing.specificity,
                    depth: enclosing.depth,
                    conditions: enclosing.conditions.clone(),
                };
                walk(&block.rules, &under, out, declared);
            }
            CssRule::Media(r) => {
                let prelude = format!("@media {}", r.query.to_css_string(PrinterOptions::default()).unwrap_or_default());
                walk(&r.rules, &enclosing.under(prelude), out, declared);
            }
            CssRule::Supports(r) => {
                let prelude = format!(
                    "@supports {}",
                    r.condition.to_css_string(PrinterOptions::default()).unwrap_or_default()
                );
                walk(&r.rules, &enclosing.under(prelude), out, declared);
            }
            CssRule::Container(r) => {
                let name = r
                    .name
                    .as_ref()
                    .map(|n| format!("{} ", n.to_css_string(PrinterOptions::default()).unwrap_or_default()))
                    .unwrap_or_default();
                let prelude = format!(
                    "@container {name}{}",
                    r.condition.to_css_string(PrinterOptions::default()).unwrap_or_default()
                );
                walk(&r.rules, &enclosing.under(prelude), out, declared);
            }
            // Bare declarations under a nested conditional (`.a { @media … {
            // gap: 1px } }`): the parent's rule, under the condition.
            CssRule::NestedDeclarations(nd) => {
                let mut declarations = Vec::new();
                for (important, list) in [
                    (false, &nd.declarations.declarations),
                    (true, &nd.declarations.important_declarations),
                ] {
                    for p in list {
                        let d = declaration(p, important);
                        if d.name.starts_with("--") {
                            declared.insert(d.name.clone());
                        }
                        declarations.push(d);
                    }
                }
                let packed = enclosing.specificity;
                out.push(Rule {
                    selector: enclosing.selector.clone().unwrap_or_default(),
                    layer: enclosing.layer.clone(),
                    specificity: ((packed >> 20) & 0x3ff, (packed >> 10) & 0x3ff, packed & 0x3ff),
                    depth: enclosing.depth,
                    conditions: enclosing.conditions.clone(),
                    declarations,
                    at: Position {
                        line: nd.loc.line + 1,
                        column: nd.loc.column,
                    },
                });
            }
            CssRule::Scope(r) => walk(&r.rules, &enclosing.under("@scope".into()), out, declared),
            CssRule::StartingStyle(r) => walk(&r.rules, &enclosing.under("@starting-style".into()), out, declared),
            _ => {}
        }
    }
}

/// A declaration as the framework reads it: name, printed value, the
/// longhands it sets.
fn declaration(p: &Property<'_>, important: bool) -> Declaration {
    let printed = p.to_css_string(false, PrinterOptions::default()).unwrap_or_default();
    let (name, value) = match printed.split_once(':') {
        Some((n, v)) => (n.trim().to_string(), v.trim().to_string()),
        None => (property_name(p), String::new()),
    };
    let longhands = match p.property_id().longhands() {
        Some(l) if !l.is_empty() => l.iter().map(|h| h.name().to_string()).collect(),
        _ => vec![name.clone()],
    };
    Declaration {
        name,
        value,
        longhands,
        important,
    }
}

fn property_name(p: &Property<'_>) -> String {
    match p {
        Property::Custom(c) => c.name.to_css_string(PrinterOptions::default()).unwrap_or_default(),
        Property::Unparsed(u) => u.property_id.name().to_string(),
        other => other.property_id().name().to_string(),
    }
}

/// Every `var(--name` read in a sheet's text, in order of first appearance.
fn reads(css: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = css;
    while let Some(i) = rest.find("var(") {
        rest = &rest[i + 4..];
        let name: String = rest
            .trim_start()
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if name.starts_with("--") && !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_come_back_as_data() {
        let css = "@layer base, component;\n@layer base { :root { --gap: 1rem; } }\n@layer component {\n  .chip, #one .chip { gap: var(--gap); color: red !important }\n}\n";
        let lowered = lower(css, "x.css", &[], false).unwrap();
        assert!(lowered.problems.is_empty(), "{:?}", lowered.problems);
        let rules = &lowered.facts.rules;
        assert_eq!(rules[0].selector, ":root");
        assert_eq!(rules[0].layer.as_deref(), Some("base"));
        assert_eq!(names(&rules[0]), vec!["--gap"]);
        assert_eq!(rules[0].declarations[0].value, "1rem");
        assert_eq!(rules[1].selector, ".chip");
        assert_eq!(rules[1].specificity, (0, 1, 0));
        assert_eq!(rules[2].selector, "#one .chip");
        assert_eq!(rules[2].specificity, (1, 1, 0));
        assert_eq!(names(&rules[2]), vec!["gap", "color"]);
        assert!(!rules[2].declarations[0].important);
        assert!(rules[2].declarations[1].important);
        assert_eq!(rules[1].at, Position { line: 4, column: 3 });
        assert!(lowered.css.contains("--gap:1rem"), "{}", lowered.css);
    }

    fn names(r: &Rule) -> Vec<&str> {
        r.declarations.iter().map(|d| d.name.as_str()).collect()
    }

    #[test]
    fn nested_rules_are_resolved_and_conditions_named() {
        let css = ".a { margin: 0; &:hover { color: blue } .b { color: green } @media (width < 40rem) { gap: 1px } }\n@supports (display: grid) { .c { display: grid } }";
        let lowered = lower(css, "x.css", &[], false).unwrap();
        let rules = &lowered.facts.rules;
        assert_eq!(rules[0].selector, ".a");
        assert_eq!(rules[0].depth, 0);
        assert_eq!(rules[0].declarations[0].name, "margin");
        assert_eq!(rules[0].declarations[0].value, "0");
        assert_eq!(
            rules[0].declarations[0].longhands,
            vec!["margin-top", "margin-right", "margin-bottom", "margin-left"]
        );
        assert_eq!(rules[1].selector, ".a:hover");
        assert_eq!(rules[1].specificity, (0, 2, 0));
        assert_eq!(rules[1].depth, 1);
        assert_eq!(rules[2].selector, ".a .b");
        assert_eq!(rules[2].specificity, (0, 2, 0));
        let media = rules.iter().find(|r| names(r) == vec!["gap"]).unwrap();
        assert_eq!(media.conditions, vec!["@media (width < 40rem)"]);
        assert_eq!(media.selector, ".a");
        assert_eq!(media.depth, 1);
        let supports = rules.iter().find(|r| r.selector == ".c").unwrap();
        assert_eq!(supports.conditions, vec!["@supports (display: grid)"]);
        assert_eq!(supports.depth, 0);
    }

    #[test]
    fn facts_are_read_before_minify() {
        // Minify would merge these two and shorten the colour.
        let css = ".a { color: #ffffff } .a { margin: 0px }";
        let lowered = lower(css, "x.css", &[], false).unwrap();
        assert_eq!(lowered.facts.rules.len(), 2);
        assert_eq!(lowered.facts.rules[0].declarations[0].value, "#fff");
        assert!(lowered.css.len() < css.len());
    }

    #[test]
    fn an_undeclared_token_read_is_a_problem() {
        let lowered = lower(".a { gap: var(--gap); margin: var(--m) }", "x.css", &["--gap".to_string()], false).unwrap();
        assert_eq!(lowered.problems.len(), 1);
        assert!(lowered.problems[0].1.contains("var(--m)"), "{:?}", lowered.problems);
    }

    #[test]
    fn an_unclosed_bracket_is_named_at_its_opener() {
        let (at, message) = lower(".a { color: red;\n.b { --w: calc(1px + 2px; }\n}", "x.css", &[], false)
            .err()
            .unwrap();
        assert_eq!(at, Some(Position { line: 2, column: 15 }), "{message}");
        assert_eq!(message, "`(` opened here is closed by `}`");
        let (_, message) = lower(".a { --w: calc(1px", "x.css", &[], false).err().unwrap();
        assert_eq!(message, "`(` is never closed");
        // Brackets inside strings and comments do not count.
        assert!(lower(".a { content: \"(\"; /* { */ }", "x.css", &[], false).is_ok());
    }

    #[test]
    fn a_source_map_is_written_when_asked() {
        let lowered = lower(".a { color: red }", "x.css", &[], true).unwrap();
        assert!(lowered.map.as_deref().unwrap().contains("x.css"), "{:?}", lowered.map);
    }
}
