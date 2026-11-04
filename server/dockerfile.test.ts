import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The API image copies an explicit list of source files. A server import missing from that list only shows up
// as a crash when Render starts the new image, so check the list against the imports here.
const copied = readFileSync('Dockerfile.api', 'utf8').split('\n').filter(l => l.startsWith('COPY ')).flatMap(l => l.slice(5).trim().split(/\s+/).slice(0, -1));

function localImports(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const m of readFileSync(file, 'utf8').matchAll(/^import[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])) + '.ts';
    localImports(target, seen);
  }
  return seen;
}

describe('Dockerfile.api', () => {
  it('copies every file the API server imports', () => {
    expect([...localImports('server.ts')].filter(f => !copied.includes(f))).toEqual([]);
  });
});
