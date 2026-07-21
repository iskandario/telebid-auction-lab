import { AuctionKind } from '../common/domain.types';
import { runArchitectureExperiment } from './experiment.simulator';
import type { ExperimentConfig } from './experiment.types';

const config: ExperimentConfig = {
  kind: AuctionKind.DIRECT,
  clients: 30,
  commands: 120,
  trials: 30,
  networkLatencyMs: 120,
  networkJitterMs: 180,
  disconnectRate: 0.2,
  duplicateRate: 0.15,
  burstWindowMs: 200,
  seed: 506911,
};

describe('architecture experiment', () => {
  it('keeps the reliable winner and clients consistent', () => {
    const result = runArchitectureExperiment(config);
    expect(result.reliable.incorrectWinnerRate).toBe(0);
    expect(result.reliable.inconsistentClientRate).toBe(0);
    expect(result.reliable.missedNotificationRate).toBe(0);
    expect(result.reliable.duplicateCommandEffectRate).toBe(0);
  });

  it('exposes failures in the naive architecture under contention', () => {
    const result = runArchitectureExperiment(config);
    expect(result.naive.incorrectWinnerRate).toBeGreaterThan(0);
    expect(result.naive.inconsistentClientRate).toBeGreaterThan(0);
    expect(result.naive.missedNotificationRate).toBeGreaterThan(0);
    expect(result.sample.naivePrice).not.toBe(result.sample.idealPrice);
    expect(result.verdict.latencyOverheadMs).toBeGreaterThan(0);
    expect(result.verdict.status).toBe('SUPPORTED');
  });

  it('is reproducible for the same seed', () => {
    const first = runArchitectureExperiment(config);
    const second = runArchitectureExperiment(config);
    expect(first.naive).toEqual(second.naive);
    expect(first.reliable).toEqual(second.reliable);
    expect(first.sample).toEqual(second.sample);
  });
});
