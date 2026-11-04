import { describe, expect, it } from 'vitest';
import { safeImageName } from './upload';

describe('safeImageName', () => {
  it('sanitizes spaces, punctuation and Unicode in image paths while preserving folders and extensions', () => {
    expect(safeImageName('User attachment.PNG')).toBe('user-attachment.png');
    expect(safeImageName('Figures & Charts/My photo 1.jpeg')).toBe('figures-charts/my-photo-1.jpeg');
    expect(safeImageName('图.png')).toBe('image.png');
    expect(safeImageName('figures//User attachment.png')).toBe('figures/user-attachment.png');
  });
});
