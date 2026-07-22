import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aggregateCsvRows,
  aggregateTrials,
  clientCsvRows,
  markdownReport,
  stripRawRows,
  trialCsvRows,
} from './report.js';
import type { AuctionKind, ScenarioConfig, TrialConfig, TrialResult } from './research.types.js';
import { runTransportTrial } from './transport.js';
import { ToxiproxyController } from './toxiproxy.js';
import { evaluateHypotheses } from './verdicts.js';

type Profile = 'quick' | 'pilot';

const CONTROL_API_URL = process.env.CONTROL_API_URL ?? 'http://localhost:8080';
const OBSERVER_API_URL = process.env.OBSERVER_API_URL ?? 'http://localhost:8666';
const TOXIPROXY_API_URL = process.env.TOXIPROXY_API_URL ?? 'http://localhost:8474';
const TOXIPROXY_UPSTREAM = process.env.TOXIPROXY_UPSTREAM ?? 'api:8080';
const datasetRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../datasets');

const scenarios: ScenarioConfig[] = [
  {
    name: 'baseline-live',
    clientsPerTransport: 2,
    bidCount: 24,
    concurrency: 4,
    commandIntervalMs: 40,
    pollIntervalMs: 250,
    networkLatencyMs: 20,
    networkJitterMs: 10,
    disconnectAfterFraction: null,
    disconnectDurationMs: 0,
    duplicateRate: 0.1,
    recoveryStrategy: 'replay',
    convergenceTimeoutMs: 6_000,
  },
  {
    name: 'mobile-reconnect',
    clientsPerTransport: 5,
    bidCount: 48,
    concurrency: 8,
    commandIntervalMs: 10,
    pollIntervalMs: 500,
    networkLatencyMs: 120,
    networkJitterMs: 80,
    disconnectAfterFraction: 0.45,
    disconnectDurationMs: 800,
    duplicateRate: 0.15,
    recoveryStrategy: 'replay',
    convergenceTimeoutMs: 8_000,
  },
  {
    name: 'final-burst-unstable',
    clientsPerTransport: 10,
    bidCount: 96,
    concurrency: 24,
    commandIntervalMs: 0,
    pollIntervalMs: 1_000,
    networkLatencyMs: 300,
    networkJitterMs: 200,
    disconnectAfterFraction: 0.6,
    disconnectDurationMs: 1_400,
    duplicateRate: 0.2,
    recoveryStrategy: 'replay',
    convergenceTimeoutMs: 12_000,
  },
];

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseProfile(): Profile {
  const value = argument('--profile') ?? process.env.RESEARCH_PROFILE ?? 'pilot';
  if (value !== 'quick' && value !== 'pilot') {
    throw new Error(`Неизвестный профиль «${value}». Используйте quick или pilot.`);
  }
  return value;
}

function git(command: string[]): string {
  try {
    return execFileSync('git', command, { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function csv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return '';
  const columns = Object.keys(rows[0]!);
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    return `"${String(value).replaceAll('"', '""')}"`;
  };
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => escape(row[column])).join(',')),
  ].join('\n');
}

function recordRows<T extends object>(rows: T[]): Array<Record<string, unknown>> {
  return rows.map((row) => row as Record<string, unknown>);
}

async function verifyApi(): Promise<Record<string, unknown>> {
  const response = await fetch(`${CONTROL_API_URL}/health`);
  if (!response.ok) throw new Error(`TeleBid API недоступен: HTTP ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

function trialConfigurations(
  runId: string,
  profile: Profile,
  repeats: number,
  initialSeed: number,
): TrialConfig[] {
  const selected = profile === 'quick' ? scenarios.slice(0, 2) : scenarios;
  const configurations: TrialConfig[] = [];
  let sequence = 0;
  selected.forEach((scenario) => {
    for (const auctionKind of ['DIRECT', 'REVERSE'] as AuctionKind[]) {
      for (let repetition = 1; repetition <= repeats; repetition += 1) {
        sequence += 1;
        configurations.push({
          ...scenario,
          runId,
          auctionKind,
          repetition,
          seed: initialSeed + sequence,
          trialId: `${scenario.name}-${auctionKind.toLowerCase()}-r${repetition}`,
        });
      }
    }
  });
  return configurations;
}

async function saveDataset(
  runId: string,
  profile: Profile,
  repeats: number,
  initialSeed: number,
  apiHealth: Record<string, unknown>,
  toxiproxyVersion: string,
  trials: TrialResult[],
): Promise<string> {
  const outputDirectory = resolve(datasetRoot, runId);
  await mkdir(outputDirectory, { recursive: true });
  const verdicts = evaluateHypotheses(trials);
  const aggregates = aggregateTrials(trials, initialSeed);
  const manifest = {
    schemaVersion: '1.1.0',
    runId,
    generatedAt: new Date().toISOString(),
    researchTopic:
      'Исследование архитектурных решений обработки конкурентных торгов и синхронизации состояния в веб-платформах прямых и обратных аукционов',
    profile,
    repeats,
    initialSeed,
    trialCount: trials.length,
    controlApiUrl: CONTROL_API_URL,
    observerApiUrl: OBSERVER_API_URL,
    toxiproxy: {
      apiUrl: TOXIPROXY_API_URL,
      version: toxiproxyVersion,
      upstream: TOXIPROXY_UPSTREAM,
      proxyName: 'telebid_research_observer',
    },
    notificationDelivery: {
      adapter: 'simulated-telegram-bot-api',
      latencyMs: 25,
      failFirstAttempt: true,
      retryBaseDelayMs: 40,
      maxAttempts: 5,
    },
    apiHealth,
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    git: {
      revision: git(['rev-parse', 'HEAD']),
      branch: git(['branch', '--show-current']),
      dirty: git(['status', '--porcelain']) !== '',
    },
    scenarios: [...new Map(trials.map((trial) => [trial.config.name, trial.config])).values()].map(
      ({ runId: ignoredRun, trialId: ignoredTrial, auctionKind: ignoredKind, repetition: ignoredRepetition, seed: ignoredSeed, ...scenario }) => scenario,
    ),
    files: {
      events: 'events.csv',
      commands: 'commands.csv',
      notifications: 'notifications.csv',
      clients: 'clients.csv',
      trials: 'trials.csv',
      aggregates: 'aggregates.csv',
      summary: 'summary.json',
      report: 'report.md',
    },
  };
  const summary = {
    runId,
    profile,
    repeats,
    verdicts,
    aggregates,
    trials: trials.map(stripRawRows),
  };
  const eventRows = trials.flatMap((trial) => trial.eventRows);
  const commandRows = trials.flatMap((trial) => trial.commandRows);
  const notificationRows = trials.flatMap((trial) => trial.notificationRows);
  const writes = [
    writeFile(resolve(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    writeFile(resolve(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8'),
    writeFile(resolve(outputDirectory, 'events.csv'), `${csv(recordRows(eventRows))}\n`, 'utf8'),
    writeFile(resolve(outputDirectory, 'commands.csv'), `${csv(recordRows(commandRows))}\n`, 'utf8'),
    writeFile(
      resolve(outputDirectory, 'notifications.csv'),
      `${csv(recordRows(notificationRows))}\n`,
      'utf8',
    ),
    writeFile(resolve(outputDirectory, 'clients.csv'), `${csv(clientCsvRows(trials))}\n`, 'utf8'),
    writeFile(resolve(outputDirectory, 'trials.csv'), `${csv(trialCsvRows(trials))}\n`, 'utf8'),
    writeFile(resolve(outputDirectory, 'aggregates.csv'), `${csv(aggregateCsvRows(aggregates))}\n`, 'utf8'),
    writeFile(
      resolve(outputDirectory, 'report.md'),
      markdownReport(runId, profile, repeats, verdicts, aggregates, trials),
      'utf8',
    ),
    writeFile(
      resolve(datasetRoot, 'latest.json'),
      `${JSON.stringify({ runId, outputDirectory, generatedAt: manifest.generatedAt }, null, 2)}\n`,
      'utf8',
    ),
  ];
  await Promise.all(writes);
  return outputDirectory;
}

async function main(): Promise<void> {
  const profile = parseProfile();
  const repeats = positiveInteger(
    argument('--repeats') ?? process.env.RESEARCH_REPEATS,
    profile === 'quick' ? 1 : 3,
  );
  const initialSeed = positiveInteger(argument('--seed') ?? process.env.RESEARCH_SEED, 506_911);
  const runId = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const apiHealth = await verifyApi();
  const toxiproxy = new ToxiproxyController({
    apiUrl: TOXIPROXY_API_URL,
    proxyName: 'telebid_research_observer',
    listen: '0.0.0.0:8666',
    upstream: TOXIPROXY_UPSTREAM,
  });
  const toxiproxyVersion = await toxiproxy.verify();
  const configurations = trialConfigurations(runId, profile, repeats, initialSeed);
  const trials: TrialResult[] = [];

  process.stdout.write(
    `TeleBid NIR-2 pilot ${runId}\nProfile: ${profile}; trials: ${configurations.length}; API: ${CONTROL_API_URL}; observer: ${OBSERVER_API_URL}\n`,
  );
  for (const [index, config] of configurations.entries()) {
    process.stdout.write(
      `RUN ${String(index + 1).padStart(2, '0')}/${configurations.length} ${config.trialId} (${config.clientsPerTransport * 3} clients, ${config.bidCount} bids)\n`,
    );
    const result = await runTransportTrial(
      config,
      { controlApiUrl: CONTROL_API_URL, observerApiUrl: OBSERVER_API_URL },
      toxiproxy,
    );
    trials.push(result);
    const stale = result.transports.reduce((sum, transport) => sum + transport.staleClients, 0);
    process.stdout.write(
      `    winner=${result.winnerCorrect ? 'OK' : 'FAIL'} stale=${stale} duplicateEffects=${result.duplicateCommandEffects} duration=${result.durationMs}ms\n`,
    );
  }

  const outputDirectory = await saveDataset(
    runId,
    profile,
    repeats,
    initialSeed,
    apiHealth,
    toxiproxyVersion,
    trials,
  );
  const verdicts = evaluateHypotheses(trials);
  process.stdout.write('\nPilot verdicts:\n');
  verdicts.forEach((verdict) => process.stdout.write(`${verdict.status.padEnd(13)} ${verdict.id} ${verdict.title}\n`));
  process.stdout.write(`\nDataset: ${outputDirectory}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
