//! Probe (#754): rolldown as a library. One ESM chunk from one entry; every
//! bare specifier (`vendor/…`, `pattern/…`, `app/…`, the import map's names)
//! stays an import.

use std::{path::Path, sync::Arc};

use rolldown::{Bundler, BundlerOptions, CodeSplittingMode, InputItem, IsExternal, OutputFormat, RawMinifyOptions, TreeshakeOptions};

/// What the bundle is printed as.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Linked and tree-shaken (rolldown always shakes), not minified.
    Linked,
    /// Dead code dropped by the minifier too, names and layout kept.
    Shaken,
    /// Shaken, compressed and mangled.
    Minified,
}

/// Bundle the graph reached from `entry`, or the diagnostics rolldown gave.
pub fn bundle(entry: &Path, mode: Mode) -> Result<String, String> {
    let runtime = tokio::runtime::Builder::new_current_thread().build().map_err(|e| e.to_string())?;
    runtime.block_on(bundle_async(entry, mode))
}

async fn bundle_async(entry: &Path, mode: Mode) -> Result<String, String> {
    let entry = entry.canonicalize().map_err(|e| e.to_string())?;
    let minify = match mode {
        Mode::Linked => RawMinifyOptions::Bool(false),
        Mode::Shaken => RawMinifyOptions::DeadCodeEliminationOnly,
        Mode::Minified => RawMinifyOptions::Bool(true),
    };
    let external = IsExternal::Fn(Some(Arc::new(|specifier: &str, _importer: Option<&str>, _resolved: bool| {
        let bare = !(specifier.starts_with("./") || specifier.starts_with("../") || specifier.starts_with('/'));
        Box::pin(async move { Ok(bare) })
    })));
    let mut bundler = Bundler::new(BundlerOptions {
        input: Some(vec![InputItem {
            name: Some("bundle".into()),
            import: entry.to_string_lossy().into_owned(),
        }]),
        cwd: Some(entry.parent().unwrap().to_path_buf()),
        external: Some(external),
        format: Some(OutputFormat::Esm),
        code_splitting: Some(CodeSplittingMode::Bool(false)),
        treeshake: TreeshakeOptions::Boolean(true),
        minify: Some(minify),
        ..Default::default()
    })
    .map_err(|e| format!("{e:?}"))?;
    let output = bundler
        .generate()
        .await
        .map_err(|errors| errors.iter().map(|e| format!("{e:?}")).collect::<Vec<_>>().join("\n"))?;
    let chunks: Vec<&rolldown_common::OutputChunk> = output
        .assets
        .iter()
        .filter_map(|a| match a {
            rolldown_common::Output::Chunk(c) => Some(&**c),
            rolldown_common::Output::Asset(_) => None,
        })
        .collect();
    if chunks.len() != 1 {
        return Err(format!("{} chunks, not one", chunks.len()));
    }
    Ok(chunks[0].code.clone())
}
