import type { DescriptiveStatistics } from './research.types.js';

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function percentile(values: number[], ratio: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1));
  return ordered[index] ?? null;
}

export function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function bootstrapMeanInterval(values: number[], seed: number): [number, number] | null {
  if (!values.length) return null;
  if (values.length === 1) return [values[0]!, values[0]!];
  const random = pseudoRandom(seed);
  const samples: number[] = [];
  for (let iteration = 0; iteration < 2_000; iteration += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      total += values[Math.floor(random() * values.length)]!;
    }
    samples.push(total / values.length);
  }
  return [percentile(samples, 0.025)!, percentile(samples, 0.975)!];
}

export function summarize(values: Array<number | null>, seed = 506_911): DescriptiveStatistics {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (!finite.length) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      median: null,
      p95: null,
      standardDeviation: null,
      meanCi95Low: null,
      meanCi95High: null,
    };
  }
  const average = mean(finite)!;
  const variance =
    finite.length > 1
      ? finite.reduce((sum, value) => sum + (value - average) ** 2, 0) / (finite.length - 1)
      : 0;
  const interval = bootstrapMeanInterval(finite, seed)!;
  return {
    count: finite.length,
    min: round(Math.min(...finite)),
    max: round(Math.max(...finite)),
    mean: round(average),
    median: round(percentile(finite, 0.5)!),
    p95: round(percentile(finite, 0.95)!),
    standardDeviation: round(Math.sqrt(variance)),
    meanCi95Low: round(interval[0]),
    meanCi95High: round(interval[1]),
  };
}
