type HandleFile = (kind: Deno.FsEvent["kind"], localFile: string) => void;

export type RegisterHandler = (handle: HandleFile) => () => void;

export function makeLazyFSWatcher(root: string): RegisterHandler {
  let watcher: Deno.FsWatcher | undefined;
  const handlers = new Set<HandleFile>();

  return (handle) => {
    handlers.add(handle);
    if (!watcher) {
      // Start watching
      watcher = Deno.watchFs(root);

      (async () => {
        for await (const event of watcher) {
          const { kind, paths } = event;
          for (const path of paths) {
            for (const handle of handlers) {
              handle(kind, path);
            }
          }
        }
      })();
    }
    return () => {
      handlers.delete(handle);
    };
  }
}
