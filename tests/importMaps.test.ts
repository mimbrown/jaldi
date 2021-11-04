import { assertEquals } from "./asserts.ts";
import { makeImportMapResolver } from "../importMaps.ts";

const mockImportMaps: Record<string, string> = {
  "/fileroot/import_map.json": JSON.stringify({
    "imports": {
      "/src/": "./src/",
      "/": "./root/",
      "@/": "../parent-src/",
      "vue": "https://bundler.com/vue@version",
    },
  }),
}

Deno.readTextFile = (path: string | URL, _options?: Deno.ReadFileOptions) => {
  if (typeof path !== 'string') {
    path = path.pathname;
  }
  if (path in mockImportMaps) {
    return Promise.resolve(mockImportMaps[path])
  }
  return Promise.reject(new Error);
}

Deno.test('Import map reflection', async () => {
  const importMapResolver = await makeImportMapResolver('/fileroot/root', '/fileroot/import_map.json');
  const reflectedMap = importMapResolver.reflectMap();
  assertEquals(reflectedMap, {
    "imports": {
      "/src/": "/@jaldi-root/src/",
      "@/": "/@jaldi-module/@/",
      "vue": "/@jaldi-module/vue",
    },
  });

  assertEquals(
    importMapResolver.resolveReflectedImport('/@jaldi-root/src/test.ts'),
    './src/test.ts',
  );
  assertEquals(
    importMapResolver.resolveReflectedImport('/@jaldi-module/vue'),
    'https://bundler.com/vue@version',
  );
  assertEquals(
    importMapResolver.resolveReflectedImport('/@jaldi-module/@/nested/mod.ts'),
    '../parent-src/nested/mod.ts',
  );
  assertEquals(
    importMapResolver.resolveReflectedImport('/src/mod.ts'),
    '/src/mod.ts',
  );
});
