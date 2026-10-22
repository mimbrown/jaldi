export const known = new Map([['k', 1]]);
export function greet(who) { return `b:${who}:${helper()}`; }
function helper() { return 'helper'; }
function UNUSED_PRIVATE_B() { return 'UNUSED_MARKER_B'; }
export const UNUSED_CONST_B = 'UNUSED_MARKER_C';
document_like();
function document_like() { globalThis.SIDE_EFFECT_B = true; console.log('SIDE_EFFECT_B'); }
