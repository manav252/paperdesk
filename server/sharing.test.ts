import { describe, expect, it } from 'vitest';
import { roleAllows } from './sharing';

describe('project roles on the server', () => {
  it('lets viewers read and compile, but change nothing', () => {
    for (const [method, sub] of [
      ['GET', ''],
      ['GET', '/pdf'],
      ['GET', '/history/5'],
      ['POST', '/compile'],
      ['POST', '/synctex'],
      ['POST', '/wordcount'],
    ])
      expect(roleAllows('viewer', method!, sub!)).toBe(true);
    for (const [method, sub] of [
      ['PUT', ''],
      ['DELETE', ''],
      ['POST', '/files'],
      ['POST', '/upload'],
      ['PUT', '/files/a'],
      ['DELETE', '/files/a'],
      ['POST', '/share'],
      ['DELETE', '/cache'],
      ['PUT', '/history/5'],
      ['POST', '/history/5/restore'],
      ['GET', '/members'],
      ['POST', '/invites'],
    ])
      expect(roleAllows('viewer', method!, sub!)).toBe(false);
  });
  it('lets editors edit, but not delete the project or manage people', () => {
    for (const [method, sub] of [
      ['PUT', ''],
      ['POST', '/files'],
      ['POST', '/upload'],
      ['PUT', '/files/a'],
      ['DELETE', '/files/a'],
      ['POST', '/history/5/restore'],
      ['POST', '/compile'],
    ])
      expect(roleAllows('editor', method!, sub!)).toBe(true);
    for (const [method, sub] of [
      ['DELETE', ''],
      ['GET', '/members'],
      ['PUT', '/members/u'],
      ['DELETE', '/members/u'],
      ['POST', '/invites'],
      ['DELETE', '/invites/t'],
      ['POST', '/something-new'],
      ['PATCH', ''],
    ])
      expect(roleAllows('editor', method!, sub!)).toBe(false);
  });
  it('allows owners everything', () => {
    expect(roleAllows('owner', 'DELETE', '')).toBe(true);
    expect(roleAllows('owner', 'POST', '/invites')).toBe(true);
  });
});
