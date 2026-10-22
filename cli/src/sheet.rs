//! Sheets with lightningcss: parsed as the browser reads them, lowered to
//! the manifest's browser floor, minified, and read back as rules for
//! the framework's own checks.

use std::collections::BTreeSet;

use jaldi_contract::{Browsers, Position, Rule, SheetFacts};
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

pub fn lower(
    text: &str,
    name: &str,
    browsers: Browsers,
    tokens: &[String],
    source_map: bool,
) -> Result<Lowered, (Option<Position>, String)> {
    // CSS error recovery is silent: an unclosed `calc(` in one custom
    // property can swallow everything after it and still parse. So first
    // a bracket balance that names the opener left open, then the parse.
    if let Some((at, message)) = unbalanced(text) {
        return Err((Some(at), message));
    }
    let targets = Targets::from(lightningcss::targets::Browsers {
        chrome: Some(version(browsers.chrome)),
        safari: Some(version(browsers.safari)),
        firefox: Some(version(browsers.firefox)),
        ..Default::default()
    });
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
    sheet
        .minify(MinifyOptions {
            targets,
            ..Default::default()
        })
        .map_err(|e| (None, format!("does not lower: {e}")))?;

    let mut rules = Vec::new();
    let mut declared = BTreeSet::new();
    walk(&sheet.rules, None, &mut rules, &mut declared);

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

/// lightningcss encodes a version as `major << 16 | minor << 8 | patch`.
fn version(major: u16) -> u32 {
    (major as u32) << 16
}

fn walk<'i>(list: &CssRuleList<'i>, layer: Option<String>, out: &mut Vec<Rule>, declared: &mut BTreeSet<String>) {
    for rule in &list.0 {
        match rule {
            CssRule::Style(style) => {
                let mut properties = Vec::new();
                for p in style
                    .declarations
                    .declarations
                    .iter()
                    .chain(style.declarations.important_declarations.iter())
                {
                    let name = property_name(p);
                    if name.starts_with("--") {
                        declared.insert(name.clone());
                    }
                    properties.push(name);
                }
                let at = Position {
                    line: style.loc.line + 1,
                    column: style.loc.column,
                };
                for selector in &style.selectors.0 {
                    let packed = selector.specificity();
                    out.push(Rule {
                        selector: selector.to_css_string(PrinterOptions::default()).unwrap_or_default(),
                        layer: layer.clone(),
                        specificity: ((packed >> 20) & 0x3ff, (packed >> 10) & 0x3ff, packed & 0x3ff),
                        properties: properties.clone(),
                        at,
                    });
                }
                walk(&style.rules, layer.clone(), out, declared);
            }
            CssRule::LayerBlock(block) => {
                let name = block
                    .name
                    .as_ref()
                    .map(|n| n.to_css_string(PrinterOptions::default()).unwrap_or_default());
                let inner = match (&layer, name) {
                    (Some(outer), Some(n)) => Some(format!("{outer}.{n}")),
                    (Some(outer), None) => Some(outer.clone()),
                    (None, n) => n,
                };
                walk(&block.rules, inner, out, declared);
            }
            CssRule::Media(r) => walk(&r.rules, layer.clone(), out, declared),
            CssRule::Supports(r) => walk(&r.rules, layer.clone(), out, declared),
            CssRule::Container(r) => walk(&r.rules, layer.clone(), out, declared),
            CssRule::Scope(r) => walk(&r.rules, layer.clone(), out, declared),
            CssRule::StartingStyle(r) => walk(&r.rules, layer.clone(), out, declared),
            _ => {}
        }
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

    const BROWSERS: Browsers = Browsers {
        chrome: 150,
        safari: 26,
        firefox: 148,
    };

    #[test]
    fn rules_come_back_as_data() {
        let css = "@layer base, component;\n@layer base { :root { --gap: 1rem; } }\n@layer component {\n  .chip, #one .chip { gap: var(--gap); color: red !important }\n}\n";
        let lowered = lower(css, "x.css", BROWSERS, &[], false).unwrap();
        assert!(lowered.problems.is_empty(), "{:?}", lowered.problems);
        let rules = &lowered.facts.rules;
        assert_eq!(rules[0].selector, ":root");
        assert_eq!(rules[0].layer.as_deref(), Some("base"));
        assert_eq!(rules[0].properties, vec!["--gap"]);
        assert_eq!(rules[1].selector, ".chip");
        assert_eq!(rules[1].specificity, (0, 1, 0));
        assert_eq!(rules[2].selector, "#one .chip");
        assert_eq!(rules[2].specificity, (1, 1, 0));
        assert_eq!(rules[2].properties, vec!["gap", "color"]);
        assert_eq!(rules[1].at, Position { line: 4, column: 3 });
        assert!(lowered.css.contains("--gap:1rem"), "{}", lowered.css);
    }

    #[test]
    fn an_undeclared_token_read_is_a_problem() {
        let lowered = lower(
            ".a { gap: var(--gap); margin: var(--m) }",
            "x.css",
            BROWSERS,
            &["--gap".to_string()],
            false,
        )
        .unwrap();
        assert_eq!(lowered.problems.len(), 1);
        assert!(lowered.problems[0].1.contains("var(--m)"), "{:?}", lowered.problems);
    }

    #[test]
    fn an_unclosed_bracket_is_named_at_its_opener() {
        let (at, message) = lower(".a { color: red;\n.b { --w: calc(1px + 2px; }\n}", "x.css", BROWSERS, &[], false)
            .err()
            .unwrap();
        assert_eq!(at, Some(Position { line: 2, column: 15 }), "{message}");
        assert_eq!(message, "`(` opened here is closed by `}`");
        let (_, message) = lower(".a { --w: calc(1px", "x.css", BROWSERS, &[], false).err().unwrap();
        assert_eq!(message, "`(` is never closed");
        // Brackets inside strings and comments do not count.
        assert!(lower(".a { content: \"(\"; /* { */ }", "x.css", BROWSERS, &[], false).is_ok());
    }

    #[test]
    fn a_source_map_is_written_when_asked() {
        let lowered = lower(".a { color: red }", "x.css", BROWSERS, &[], true).unwrap();
        assert!(lowered.map.as_deref().unwrap().contains("x.css"), "{:?}", lowered.map);
    }
}
