function appendSourceMap(contents: string, sourceMap: string) {
  return `${contents}\n//# sourceMappingURL=data:application/json;base64,${btoa(sourceMap)}`;
}

export interface Cache {
  cacheDep: (localFile: string) => Promise<string>;
  bundleDep: (localFile: string) => Promise<void>;
  uncache: (localFile: string) => void;
  getDep(localFile: string): Promise<string>;
}

export function makeCache() {
  const cache: Record<string, string> = {};
  const toCacheKey = (localFile: string) => `file://${localFile}.js`;
  const cacheDep = async (localFile: string) => {
    const { files } = await Deno.emit(localFile, {
      check: false,
    });
    for (const [key, contents] of Object.entries(files)) {
      if (key.endsWith('.js')) {
        cache[key] = appendSourceMap(contents, files[key + '.map']);
      }
    }
    return cache[toCacheKey(localFile)];
  };

  const bundleDep = async (localFile: string) => {
    const { files } = await Deno.emit(localFile, {
      bundle: 'module',
      check: false,
    });
    cache[`file://${localFile}.js`] = appendSourceMap(
      files['deno:///bundle.js'],
      files['deno:///bundle.js.map'],
    );
  };

  return {
    cacheDep,
    bundleDep,

    uncache(localFile: string) {
      delete cache[toCacheKey(localFile)];
    },

    async getDep(localFile: string) {
      const key = toCacheKey(localFile);
      if (!(key in cache)) {
        await cacheDep(localFile);
      }
      return cache[key];
    }
  };
}