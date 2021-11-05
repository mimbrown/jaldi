import { makeCache } from './cache.ts';
import { join, serve, ServerRequest, Response, parse } from './deps.ts';
import { makeLazyFSWatcher, RegisterHandler } from './fsWatcher.ts';
import { FileDescriptor } from "./handlers/types.ts";

const port = 8000;

function makeLazyLoader<T>(load: () => Promise<T>) {
  let mod: undefined | T;

  return async () => {
    if (!mod) {
      mod = await load();
    }
    return mod;
  };
}

interface ImportMap {
  imports: Record<string, string>;
}

function makeFileServer(root: string, importMap?: ImportMap) {
  console.log(root);
  const registerHandler = makeLazyFSWatcher(root);
  const cache = makeCache();

  let injectableImportMap: string | undefined;
  if (importMap) {
    const { imports } = importMap;
    const newImports: ImportMap["imports"] = {};
    for (const key in imports) {
      const value = imports[key];
      if (/^https?:\/\//.test(value)) {
        let redirected = join('/@jaldi-import', key);
        if (value.endsWith('/')) {
          redirected += '/';
        }
        newImports[key] = redirected;
      }
    }
    injectableImportMap = `<script type="importmap">${JSON.stringify(importMap)}</script>`;
    // injectableImportMap = `<script type="importmap">${JSON.stringify({ imports: newImports })}</script>`;
  }

  const getTypescriptHandler = makeLazyLoader(async () =>
    (await import('./handlers/typescript.ts')).create(registerHandler, cache)
  );
  const getVueHandler = makeLazyLoader(async () =>
    (await import('./handlers/vue.ts')).makeVueHandler()
  );

  const makeFileDescriptor = (pathname: string): FileDescriptor => {
    const path = join(root, pathname);
    return {
      contents: () => Deno.readTextFile(path),
      path,
      get uri() {
        return 'file://' + path;
      }
    }
  }
  
  return async function serveFile(request: ServerRequest): Promise<Response> {
    const url = new URL(request.url, `http://localhost:${port}`);

    const headers = new Headers();
    
    const { pathname } = url;
    const localFile = join(root, pathname);
    let { ext } = parse(localFile);

    if (importMap && pathname.startsWith('/@jaldi-import/')) {
      const module = pathname.replace('/@jaldi-import/', '');
      for (const [key, value] of Object.entries(importMap.imports)) {
        if (key === module) {
          await Deno.emit(localFile, {

          });
        }
      }
    }
    else if (/\.tsx?$/.test(pathname)) {
      const handler = await getTypescriptHandler();
      headers.append('Content-Type', 'application/javascript');
      return {
        body: await handler(localFile),
        headers,
      };
    }
    else if (/\.vue$/.test(pathname)) {
      const handler = await getVueHandler();
      headers.append('Content-Type', 'application/javascript');
      return {
        body: await handler(makeFileDescriptor(pathname), url),
        headers,
      };
    }

    if (pathname.endsWith('.js')) {
      headers.append('Content-Type', 'application/javascript');
    }

    let body: string;
    try {
      body = await Deno.readTextFile(localFile);
    } catch {
      body = await Deno.readTextFile(join(localFile, 'index.html'));
      ext = '.html';
    }

    if (ext === '.html' && injectableImportMap) {
      body = body.replace(
        /(?<=([\t ]*)<head[^>]*>)/,
        (_, tab) => tab + '  ' + injectableImportMap,
      );
    }

    return { body, headers };
  };
}

const [folder, importMap] = Deno.args;
const serveFile = makeFileServer(
  join(Deno.cwd(), folder),
  importMap && JSON.parse(await Deno.readTextFile(importMap)),
);

async function handle(request: ServerRequest) {
  try {
    request.respond(await serveFile(request))
  } catch (err) {
    console.error(err);
    request.respond({ body: err.stack });
  }
}

const server = serve({ port });
console.log(`Server listening at http://localhost:${port}`);
for await (const req of server) {
  handle(req);
}
