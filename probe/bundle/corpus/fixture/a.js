// Side effect at evaluation: must survive and run before entry's body.
console.log('SIDE_EFFECT_A');
export let counter = 0;
export function bump() { counter += 1; }
export function greet(who) { return `a:${who}`; }
export function UNUSED_A() { return 'UNUSED_MARKER_A'; }
const known = 'a-private';
export const shorthand = { known };
