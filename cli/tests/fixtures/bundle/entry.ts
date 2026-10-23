// The linker's fixture: each line of output names a property the bundle
// keeps; the expected output is what the modules print unbundled.
import { greet, counter, bump } from './a.js';
import { greet as greetB, known } from './b.js';
import shout from './c.js';
import * as ns from './d.js';
import { again } from './reexport.js';
import { cyclic } from './cycle-a.js';
import './effects.js';
import { shadowed } from './shadow.js';
console.log('entry', greet('a'), greetB('b'), shout('c'));
bump();
bump();
console.log('live binding', counter);
console.log('collision', known.size, ns.known);
console.log('namespace', Object.keys(ns).sort().join(','));
console.log('re-export', again('r'));
console.log('cycle', cyclic());
console.log('shadow', shadowed());
console.log('meta', typeof import.meta);
const later = 'lazy';
Reflect.set(globalThis, 'loadLater', () => import(`pattern/${later}`));
