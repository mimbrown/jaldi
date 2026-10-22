// Sizes over the wire: raw, gzip -9, brotli 11, for a set of files summed.
import fs from 'node:fs'; import zlib from 'node:zlib';
const [label, ...files] = process.argv.slice(2);
let raw = 0, gz = 0, br = 0;
for (const f of files) { const b = fs.readFileSync(f); raw += b.length; gz += zlib.gzipSync(b, { level: 9 }).length;
  br += zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length; }
console.log(`${label}\t${files.length} files\traw ${raw}\tgzip ${gz}\tbrotli ${br}`);
