import { other } from './cycle-a.js';
export function half() { return `half:${other()}`; }
