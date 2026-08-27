import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const scripts = ['../scripts/backup-postgres.sh', '../scripts/verify-postgres-backup.sh'];

for (const relativePath of scripts) {
  test(`${relativePath} używa końców linii zgodnych z kontenerem Linux`, async () => {
    const content = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(content, /^#!\/bin\/sh\nset -eu\n/);
    assert.doesNotMatch(content, /\r/);
  });
}
