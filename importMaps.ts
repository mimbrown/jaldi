import { join, parse, urlJoin } from './deps.ts';

interface ImportMap {
  imports: Record<string, string>;
}

export const toHTMLInjectable = (importMap: ImportMap) =>
  `<script type="importmap">${JSON.stringify(importMap)}</script>`;

export async function makeImportMapResolver(root: string, importMapPath: string) {
  const importMap = JSON.parse(await Deno.readTextFile(importMapPath)) as ImportMap;
  const { dir: importMapLocation } = parse(importMapPath);

  const resolveImport = (pathname: string) => {
    for (const [from, to] of Object.entries(importMap.imports)) {
      if (
        pathname === from ||
        (from.endsWith('/') && pathname.startsWith(from))
      ) {
        return to + pathname.slice(from.length);
      }
    }
    return pathname;
  }

  return {
    reflectMap(): ImportMap {
      const { imports } = importMap;
      const reflectedImports: ImportMap["imports"] = {};
      for (const [from, to] of Object.entries(imports)) {
        let redirected: string | undefined;

        if (/^\//.test(from)) {
          // If this matches what is resolved by the root anyway,
          // don't add it to the reflected map.
          if (join(importMapLocation, to) !== join(root, from)) {
            redirected = urlJoin('/@jaldi-root', from);
          }
        } else {
          redirected = urlJoin('/@jaldi-module', from);
        }
        if (redirected) {
          reflectedImports[from] = redirected;
        }
      }
      return { imports: reflectedImports };
    },
    resolveImport,
    resolveReflectedImport(pathname: string) {
      let unprefixed: string | undefined;
      if (pathname.startsWith('/@jaldi-root/')) {
        // KEEP trailing slash
        unprefixed = pathname.slice(12);
      } else if (pathname.startsWith('/@jaldi-module/')) {
        // REMOVE trailing slash
        unprefixed = pathname.slice(15);
      }
      if (typeof unprefixed === 'string') {
        return resolveImport(unprefixed);
      }
      return pathname;
    },
  };
  // injectableImportMap = `<script type="importmap">${JSON.stringify({ imports: newImports })}</script>`;
}