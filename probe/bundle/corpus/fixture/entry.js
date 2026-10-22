// The probe's correctness fixture: each line of output names a property the
// bundle must keep; `node entry.js` and `node bundle.js` print the same.
import { greet, counter, bump } from './a.js';
import { greet as greetB, known } from './b.js';
import shout from './c.js';
import * as ns from './d.js';
import { again } from './reexport.js';
import { cyclic } from './cycle-a.js';
console.log('entry', greet('a'), greetB('b'), shout('c'));
bump(); bump();
console.log('live binding', counter);
console.log('collision', known.size, ns.known);
console.log('namespace', Object.keys(ns).sort().join(','));
console.log('re-export', again('r'));
console.log('cycle', cyclic());
console.log('dynamic', typeof import.meta);
export const loadLater = () => import('pattern/lazy');
