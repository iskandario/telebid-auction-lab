import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { percentile, summarize } from './statistics.js';

describe('research statistics', () => {
  it('calculates nearest-rank percentiles', () => {
    assert.equal(percentile([5, 1, 4, 2, 3], 0.5), 3);
    assert.equal(percentile([5, 1, 4, 2, 3], 0.95), 5);
  });

  it('returns deterministic descriptive statistics and confidence interval', () => {
    const first = summarize([10, 20, 30, 40], 42);
    const second = summarize([10, 20, 30, 40], 42);
    assert.deepEqual(first, second);
    assert.equal(first.mean, 25);
    assert.equal(first.median, 20);
    assert.ok(first.meanCi95Low! <= first.mean!);
    assert.ok(first.meanCi95High! >= first.mean!);
  });
});
