import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { templateStarters } from './templates';

describe('template starters', () => {
  it('matches each source to its real compile fixture', () => {
    for (const template of templateStarters) {
      const fixture = readFileSync(new URL(`../../test/fixtures/compile/${template.id}/main.tex`, import.meta.url), 'utf8');
      expect(template.source).toBe(fixture);
      for (const file of template.files ?? []) {
        const asset = readFileSync(new URL(`../../test/fixtures/compile/${template.id}/${file.name}`, import.meta.url), 'utf8');
        expect(file.content).toBe(asset);
      }
    }
  });
});
