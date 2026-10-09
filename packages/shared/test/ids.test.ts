import { describe, expect, it } from 'vitest';
import { idTime, isId, newId } from '../src/ids';

describe('ulid', () => {
  it('is sortable and monotonic within the same ms', () => {
    const t = 1_760_000_000_000;
    const ids = Array.from({ length: 50 }, () => newId(t));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
    expect(ids.every(isId)).toBe(true);
    expect(idTime(ids[0]!)).toBe(t);
  });
});
