import { describe, expect, it } from 'vitest';
import { double } from './smoke-reuse.ts';

describe('double', () => {
  it('should return twice the input when given a number', () => {
    expect(double(2)).toBe(4);
  });
});
