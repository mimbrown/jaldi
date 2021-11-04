import { RegisterHandler } from '../fsWatcher.ts';
import { Cache } from '../cache.ts';

export type TypescriptHandler = (localFile: string) => Promise<string>;

export function create(registerHandler: RegisterHandler, cache: Cache): TypescriptHandler {
  registerHandler((_, localFile) => {
    cache.uncache(localFile);
  });

  return (localFile: string): Promise<string> => {
    return cache.getDep(localFile);
    // const { pathname } = context.request.url;
    // if (/\.tsx?$/.test(pathname)) {
    //   // Do it ourselves.
    //   const localFile = toAbsolute(pathname);
    //   const fileKey = toCacheKey(localFile);
    //   let contents = prebundled[fileKey] ?? cache[fileKey];
    //   if (!contents) {
    //     // Parse and cache...
    //     contents = await cacheDep(localFile);
    //   }
    //   const sourceMap = `${pathname}.js.map`;
    //   // context.response.body = `${contents}\n//# sourceMappingURL=${sourceMap}`;
    //   context.response.body = `${contents}\n//# sourceMappingURL=data:application/json;base64,${btoa(sourceMap)}`;
    //   // context.response.type = '.js';
    //   // context.response.headers.set('SourceMap', sourceMap);
    // } else if (pathname.endsWith('.js.map')) {
    //   const fileKey = `file://${toAbsolute(pathname)}`;
    //   context.response.body = prebundled[fileKey] ?? cache[fileKey];
    //   context.response.type = '.map';
    // } else {
    //   await next();
    // }
  };
}
