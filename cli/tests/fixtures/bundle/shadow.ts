import { greet as known } from './a.js';
// A nested binding named as the import resolves to (`greet`, a's): the
// linker renames it out of the way so `known` still reads a's.
export function shadowed(): string {
  const greet = (s: string): string => `nested:${s}`;
  return `${greet('x')} ${known('y')}`;
}
