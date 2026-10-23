import { half } from './cycle-b.js';
export function cyclic(): string {
  return `cycle:${half()}`;
}
export function other(): string {
  return 'other';
}
