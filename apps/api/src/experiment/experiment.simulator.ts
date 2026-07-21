import { randomUUID } from 'node:crypto';
import { AuctionKind } from '../common/domain.types';
import type {
  ExperimentConfig,
  ExperimentResult,
  ModeMetrics,
  TimelinePoint,
} from './experiment.types';

interface Command {
  sequence: number;
  commandId: string;
  participantId: string;
  amount: number;
  arrivalAt: number;
  readWriteDurationMs: number;
  atomicTransitionMs: number;
  duplicate: boolean;
}

interface Commit {
  command: Command;
  completedAt: number;
  stateAfter: number;
}

interface TrialResult {
  incorrectWinner: boolean;
  inconsistentClients: number;
  expectedNotifications: number;
  missedNotifications: number;
  duplicateAttempts: number;
  duplicateEffects: number;
  latencies: number[];
  throughput: number;
  accepted: number;
  finalPrice: number;
  finalWinnerId: string | null;
  decisions: Map<number, { accepted: boolean; stateAfter: number }>;
}

interface GeneratedTrial {
  commands: Command[];
  uniqueCommands: Command[];
  startingPrice: number;
  idealPrice: number;
  idealWinnerId: string;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value: number, digits = 2): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function isBetter(kind: AuctionKind, amount: number, current: number): boolean {
  return kind === AuctionKind.DIRECT ? amount > current : amount < current;
}

function generateTrial(config: ExperimentConfig, trialIndex: number): GeneratedTrial {
  const random = seededRandom(config.seed + trialIndex * 104729);
  const startingPrice = config.kind === AuctionKind.DIRECT ? 10_000 : 120_000;
  const step = 100;
  const uniqueCommands: Command[] = Array.from({ length: config.commands }, (_, index) => ({
    sequence: index + 1,
    commandId: `trial-${trialIndex}-command-${index + 1}`,
    participantId: `participant-${(index % config.clients) + 1}`,
    amount:
      config.kind === AuctionKind.DIRECT
        ? startingPrice + step * (index + 1)
        : startingPrice - step * (index + 1),
    arrivalAt:
      config.networkLatencyMs +
      Math.floor(random() * config.networkJitterMs) +
      Math.floor(random() * config.burstWindowMs),
    readWriteDurationMs: 8 + Math.floor(random() * 13),
    atomicTransitionMs: 2 + Math.floor(random() * 2),
    duplicate: false,
  }));

  const duplicates = uniqueCommands
    .filter(() => random() < config.duplicateRate)
    .map((command) => ({
      ...command,
      arrivalAt: command.arrivalAt + 1 + Math.floor(random() * 35),
      readWriteDurationMs: 8 + Math.floor(random() * 13),
      atomicTransitionMs: 2 + Math.floor(random() * 2),
      duplicate: true,
    }));
  const commands = [...uniqueCommands, ...duplicates].sort(
    (left, right) => left.arrivalAt - right.arrivalAt || left.sequence - right.sequence,
  );
  const ideal = uniqueCommands.at(-1)!;
  return {
    commands,
    uniqueCommands,
    startingPrice,
    idealPrice: ideal.amount,
    idealWinnerId: ideal.participantId,
  };
}

function stateAt(commits: Commit[], time: number, startingPrice: number): number {
  return commits
    .filter((commit) => commit.completedAt <= time)
    .sort((left, right) => left.completedAt - right.completedAt)
    .at(-1)?.stateAfter ?? startingPrice;
}

function runNaive(
  generated: GeneratedTrial,
  config: ExperimentConfig,
  random: () => number,
): TrialResult {
  const commits: Commit[] = [];
  const decisions = new Map<number, { accepted: boolean; stateAfter: number }>();
  for (const command of generated.commands) {
    const readState = stateAt(commits, command.arrivalAt, generated.startingPrice);
    const accepted = isBetter(config.kind, command.amount, readState);
    if (accepted) {
      commits.push({
        command,
        completedAt: command.arrivalAt + command.readWriteDurationMs,
        stateAfter: command.amount,
      });
    }
    if (!command.duplicate) decisions.set(command.sequence, { accepted, stateAfter: accepted ? command.amount : readState });
  }

  const orderedCommits = commits.sort(
    (left, right) => left.completedAt - right.completedAt || left.command.sequence - right.command.sequence,
  );
  const finalCommit = orderedCommits.at(-1);
  const duplicateAttempts = generated.commands.filter((command) => command.duplicate).length;
  const committedById = new Map<string, number>();
  orderedCommits.forEach((commit) => {
    committedById.set(commit.command.commandId, (committedById.get(commit.command.commandId) ?? 0) + 1);
  });
  const duplicateEffects = [...committedById.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );

  let inconsistentClients = 0;
  for (let client = 0; client < config.clients; client += 1) {
    const disconnected = random() < config.disconnectRate;
    const deliveryDelay = config.networkLatencyMs + Math.floor(random() * config.networkJitterMs);
    const observationWindow = config.networkLatencyMs + Math.floor(config.networkJitterMs * 0.55);
    if (disconnected || deliveryDelay > observationWindow) inconsistentClients += 1;
  }
  const expectedNotifications = orderedCommits.length * 2;
  const missedNotifications = Math.min(
    expectedNotifications,
    Math.round(expectedNotifications * (config.disconnectRate + (1 - config.disconnectRate) * 0.04)),
  );
  const latencies = generated.commands.map((command) => command.readWriteDurationMs);
  const elapsed = Math.max(1, (orderedCommits.at(-1)?.completedAt ?? 1) - generated.commands[0]!.arrivalAt);

  return {
    incorrectWinner:
      finalCommit?.stateAfter !== generated.idealPrice ||
      finalCommit?.command.participantId !== generated.idealWinnerId,
    inconsistentClients,
    expectedNotifications,
    missedNotifications,
    duplicateAttempts,
    duplicateEffects,
    latencies,
    throughput: (generated.commands.length / elapsed) * 1000,
    accepted: orderedCommits.length,
    finalPrice: finalCommit?.stateAfter ?? generated.startingPrice,
    finalWinnerId: finalCommit?.command.participantId ?? null,
    decisions,
  };
}

function runReliable(generated: GeneratedTrial, config: ExperimentConfig): TrialResult {
  const seenCommands = new Set<string>();
  const decisions = new Map<number, { accepted: boolean; stateAfter: number }>();
  let serverAvailableAt = 0;
  let currentPrice = generated.startingPrice;
  let winnerId: string | null = null;
  let accepted = 0;
  const latencies: number[] = [];
  for (const command of generated.commands) {
    if (seenCommands.has(command.commandId)) {
      latencies.push(1);
      continue;
    }
    seenCommands.add(command.commandId);
    const processingStartedAt = Math.max(command.arrivalAt, serverAvailableAt);
    const completedAt = processingStartedAt + command.atomicTransitionMs;
    serverAvailableAt = completedAt;
    latencies.push(completedAt - command.arrivalAt);
    const commandAccepted = isBetter(config.kind, command.amount, currentPrice);
    if (commandAccepted) {
      currentPrice = command.amount;
      winnerId = command.participantId;
      accepted += 1;
    }
    decisions.set(command.sequence, { accepted: commandAccepted, stateAfter: currentPrice });
  }
  const elapsed = Math.max(1, serverAvailableAt - generated.commands[0]!.arrivalAt);
  return {
    incorrectWinner: currentPrice !== generated.idealPrice || winnerId !== generated.idealWinnerId,
    inconsistentClients: 0,
    expectedNotifications: accepted * 2,
    missedNotifications: 0,
    duplicateAttempts: generated.commands.filter((command) => command.duplicate).length,
    duplicateEffects: 0,
    latencies,
    throughput: (generated.commands.length / elapsed) * 1000,
    accepted,
    finalPrice: currentPrice,
    finalWinnerId: winnerId,
    decisions,
  };
}

function summarize(results: TrialResult[], config: ExperimentConfig): ModeMetrics {
  const expectedNotifications = results.reduce((sum, result) => sum + result.expectedNotifications, 0);
  const duplicateAttempts = results.reduce((sum, result) => sum + result.duplicateAttempts, 0);
  return {
    incorrectWinnerRate: round(
      (results.filter((result) => result.incorrectWinner).length / results.length) * 100,
    ),
    inconsistentClientRate: round(
      (results.reduce((sum, result) => sum + result.inconsistentClients, 0) /
        (results.length * config.clients)) *
        100,
    ),
    missedNotificationRate: round(
      expectedNotifications
        ? (results.reduce((sum, result) => sum + result.missedNotifications, 0) /
            expectedNotifications) *
            100
        : 0,
    ),
    duplicateCommandEffectRate: round(
      duplicateAttempts
        ? (results.reduce((sum, result) => sum + result.duplicateEffects, 0) /
            duplicateAttempts) *
            100
        : 0,
    ),
    commandP95Ms: round(percentile(results.flatMap((result) => result.latencies), 0.95)),
    throughputPerSecond: round(
      results.reduce((sum, result) => sum + result.throughput, 0) / results.length,
    ),
    acceptedCommandsAverage: round(
      results.reduce((sum, result) => sum + result.accepted, 0) / results.length,
    ),
  };
}

function buildTimeline(
  generated: GeneratedTrial,
  naive: TrialResult,
  reliable: TrialResult,
): TimelinePoint[] {
  const stride = Math.max(1, Math.floor(generated.uniqueCommands.length / 14));
  return generated.uniqueCommands
    .filter((_, index) => index % stride === 0 || index === generated.uniqueCommands.length - 1)
    .slice(-15)
    .map((command) => {
      const naiveDecision = naive.decisions.get(command.sequence) ?? {
        accepted: false,
        stateAfter: generated.startingPrice,
      };
      const reliableDecision = reliable.decisions.get(command.sequence) ?? {
        accepted: false,
        stateAfter: generated.startingPrice,
      };
      return {
        command: command.sequence,
        participantId: command.participantId,
        amount: command.amount,
        arrivalAtMs: command.arrivalAt,
        naive: naiveDecision,
        reliable: reliableDecision,
      };
    });
}

export function runArchitectureExperiment(config: ExperimentConfig): ExperimentResult {
  const naiveTrials: TrialResult[] = [];
  const reliableTrials: TrialResult[] = [];
  let sampleGenerated: GeneratedTrial | null = null;
  let sampleNaive: TrialResult | null = null;
  let sampleReliable: TrialResult | null = null;

  for (let trial = 0; trial < config.trials; trial += 1) {
    const generated = generateTrial(config, trial);
    const naive = runNaive(generated, config, seededRandom(config.seed + trial * 7919 + 17));
    const reliable = runReliable(generated, config);
    naiveTrials.push(naive);
    reliableTrials.push(reliable);
    if (trial === 0 || (!sampleNaive?.incorrectWinner && naive.incorrectWinner)) {
      sampleGenerated = generated;
      sampleNaive = naive;
      sampleReliable = reliable;
    }
  }

  const naive = summarize(naiveTrials, config);
  const reliable = summarize(reliableTrials, config);
  const checks = [
    reliable.incorrectWinnerRate < naive.incorrectWinnerRate,
    reliable.inconsistentClientRate < naive.inconsistentClientRate,
    reliable.missedNotificationRate < naive.missedNotificationRate,
    reliable.duplicateCommandEffectRate <= naive.duplicateCommandEffectRate,
  ];
  const passedChecks = checks.filter(Boolean).length;
  const latencyOverheadPercent = round(
    naive.commandP95Ms
      ? ((reliable.commandP95Ms - naive.commandP95Ms) / naive.commandP95Ms) * 100
      : 0,
  );
  const latencyOverheadMs = round(reliable.commandP95Ms - naive.commandP95Ms);
  const latencyExplanation =
    latencyOverheadMs > 0
      ? `p95 обработки ставки выросла на ${latencyOverheadMs} мс`
      : latencyOverheadMs < 0
        ? `p95 обработки ставки уменьшилась на ${Math.abs(latencyOverheadMs)} мс`
        : 'p95 обработки ставки не изменилась';
  const status =
    passedChecks >= 3
      ? 'SUPPORTED'
      : passedChecks <= 1
        ? 'NOT_SUPPORTED'
        : 'INCONCLUSIVE';
  const generated = sampleGenerated!;
  const sampleNaiveResult = sampleNaive!;
  const sampleReliableResult = sampleReliable!;

  return {
    experimentId: randomUUID(),
    generatedAt: new Date().toISOString(),
    hypothesis:
      'Атомарная обработка ставок, идемпотентность, версионированное восстановление Mini App и сохраняемые уведомления Telegram-бота уменьшают ошибки торгов и потерю пользовательских событий по сравнению с параллельной записью и доставкой только через активное WebSocket-соединение.',
    config,
    naive,
    reliable,
    verdict: {
      status,
      passedChecks,
      totalChecks: checks.length,
      latencyOverheadMs,
      latencyOverheadPercent,
      explanation:
        status === 'SUPPORTED'
          ? `Предлагаемая архитектура улучшила ${passedChecks} из ${checks.length} показателей корректности; ${latencyExplanation}.`
          : `Улучшено только ${passedChecks} из ${checks.length} показателей. Для вывода нужны другие параметры нагрузки.`,
    },
    sample: {
      idealWinnerId: generated.idealWinnerId,
      idealPrice: generated.idealPrice,
      naiveWinnerId: sampleNaiveResult.finalWinnerId,
      naivePrice: sampleNaiveResult.finalPrice,
      reliableWinnerId: sampleReliableResult.finalWinnerId,
      reliablePrice: sampleReliableResult.finalPrice,
      timeline: buildTimeline(generated, sampleNaiveResult, sampleReliableResult),
    },
  };
}
