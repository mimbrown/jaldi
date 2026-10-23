import type { Shape } from './types.js';
export const known: Map<string, number> = new Map([['k', 1]]);
export function greet(who: string): string {
  return `b:${who}:${helper()}`;
}
function helper(): string {
  return 'helper';
}
function UNUSED_PRIVATE_B(): string {
  return 'UNUSED_MARKER_B';
}
export const UNUSED_CONST_B = 'UNUSED_MARKER_C';
export const shape: Shape = { side: 2 };
// A side-effecting top-level statement calling a private function: both stay.
documentLike();
function documentLike(): void {
  Reflect.set(globalThis, 'SIDE_EFFECT_B', true);
  console.log('SIDE_EFFECT_B');
}
