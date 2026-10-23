import { other } from './cycle-a.js';
export function half(): string {
  return `half:${other()}`;
}
