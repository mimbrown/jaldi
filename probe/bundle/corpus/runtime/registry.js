// The patterns an app registers statically. Its own module so the generated
// registration evaluates before the shim mounts what the document holds:
// an entry's own body runs after every module it imports.
export const patterns = new Map();
