import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const suffix of ['', '-shm', '-wal']) {
  await rm(join(root, 'data', `voice.sqlite${suffix}`), { force: true });
}
console.log('Lokalna baza Voice Reception została wyczyszczona.');
