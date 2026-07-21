import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type AuctionKind = 'DIRECT' | 'REVERSE';

interface ExperimentInput {
  kind: AuctionKind;
  clients: number;
  commands: number;
  trials: number;
  networkLatencyMs: number;
  networkJitterMs: number;
  disconnectRate: number;
  duplicateRate: number;
  burstWindowMs: number;
  seed: number;
}

interface Metrics {
  incorrectWinnerRate: number;
  inconsistentClientRate: number;
  missedNotificationRate: number;
  duplicateCommandEffectRate: number;
  commandP95Ms: number;
  throughputPerSecond: number;
  acceptedCommandsAverage: number;
}

interface Result {
  experimentId: string;
  config: ExperimentInput;
  naive: Metrics;
  reliable: Metrics;
  verdict: {
    status: 'SUPPORTED' | 'NOT_SUPPORTED' | 'INCONCLUSIVE';
    passedChecks: number;
    totalChecks: number;
    latencyOverheadMs: number;
    latencyOverheadPercent: number;
    explanation: string;
  };
}

const API_URL = process.env.API_URL ?? 'http://localhost:8080';
const outputDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../../datasets');

const scenarios: Array<{ name: string; input: ExperimentInput }> = [
  {
    name: 'direct-final-burst-mobile',
    input: {
      kind: 'DIRECT',
      clients: 30,
      commands: 120,
      trials: 40,
      networkLatencyMs: 120,
      networkJitterMs: 180,
      disconnectRate: 0.2,
      duplicateRate: 0.12,
      burstWindowMs: 250,
      seed: 506911,
    },
  },
  {
    name: 'reverse-final-burst-mobile',
    input: {
      kind: 'REVERSE',
      clients: 30,
      commands: 120,
      trials: 40,
      networkLatencyMs: 120,
      networkJitterMs: 180,
      disconnectRate: 0.2,
      duplicateRate: 0.12,
      burstWindowMs: 250,
      seed: 506912,
    },
  },
  {
    name: 'direct-stress-unstable',
    input: {
      kind: 'DIRECT',
      clients: 100,
      commands: 500,
      trials: 25,
      networkLatencyMs: 300,
      networkJitterMs: 500,
      disconnectRate: 0.38,
      duplicateRate: 0.25,
      burstWindowMs: 100,
      seed: 506913,
    },
  },
];

async function run(input: ExperimentInput): Promise<Result> {
  const response = await fetch(`${API_URL}/experiments/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Experiment API returned HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<Result>;
}

function csv(results: Array<{ name: string; result: Result }>): string {
  const header = [
    'scenario',
    'kind',
    'mode',
    'incorrect_winner_rate',
    'inconsistent_client_rate',
    'missed_notification_rate',
    'duplicate_command_effect_rate',
    'command_p95_ms',
    'throughput_per_second',
  ];
  const rows = results.flatMap(({ name, result }) =>
    (['naive', 'reliable'] as const).map((mode) => [
      name,
      result.config.kind,
      mode,
      result[mode].incorrectWinnerRate,
      result[mode].inconsistentClientRate,
      result[mode].missedNotificationRate,
      result[mode].duplicateCommandEffectRate,
      result[mode].commandP95Ms,
      result[mode].throughputPerSecond,
    ]),
  );
  return [header, ...rows].map((row) => row.join(',')).join('\n') + '\n';
}

function markdown(results: Array<{ name: string; result: Result }>, passed: boolean): string {
  const rows = results.flatMap(({ name, result }) =>
    (['naive', 'reliable'] as const).map(
      (mode) =>
        `| ${name} | ${mode} | ${result[mode].incorrectWinnerRate}% | ${result[mode].inconsistentClientRate}% | ${result[mode].missedNotificationRate}% | ${result[mode].duplicateCommandEffectRate}% | ${result[mode].commandP95Ms} |`,
    ),
  );
  return [
    '# Автоматическая проверка архитектурной гипотезы',
    '',
    `Итог: **${passed ? 'PASS' : 'FAIL'}**`,
    '',
    'Гипотеза: атомарная обработка команд, идемпотентность, версионированное восстановление Telegram Mini App и сохраняемые уведомления бота уменьшают ошибки торгов и потерю пользовательских событий.',
    '',
    '| Сценарий | Режим | Неверный победитель | Рассинхрон клиентов | Потеря уведомлений | Повтор команды | p95, мс |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
    'Критерий PASS: во всех сценариях предлагаемая архитектура не допускает неправильного победителя, рассинхрона Mini App, потери уведомлений и повторного применения команды; итоговый вердикт API — SUPPORTED.',
    '',
  ].join('\n');
}

async function main() {
  const runId = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const results: Array<{ name: string; result: Result }> = [];
  process.stdout.write(`Architecture experiment ${runId}\n`);
  for (const scenario of scenarios) {
    process.stdout.write(`RUN  ${scenario.name}\n`);
    const result = await run(scenario.input);
    results.push({ name: scenario.name, result });
    process.stdout.write(
      `${result.verdict.status.padEnd(10)} naive winner errors ${result.naive.incorrectWinnerRate}% → reliable ${result.reliable.incorrectWinnerRate}%\n`,
    );
  }

  const passed = results.every(
    ({ result }) =>
      result.verdict.status === 'SUPPORTED' &&
      result.reliable.incorrectWinnerRate === 0 &&
      result.reliable.inconsistentClientRate === 0 &&
      result.reliable.missedNotificationRate === 0 &&
      result.reliable.duplicateCommandEffectRate === 0,
  );
  const summary = {
    runId,
    hypothesis: 'Hybrid Mini App and Telegram Bot delivery improves correctness under contention and connection loss.',
    passed,
    scenarios: results,
  };
  await mkdir(outputDirectory, { recursive: true });
  const jsonPath = resolve(outputDirectory, `${runId}-architecture-summary.json`);
  const csvPath = resolve(outputDirectory, `${runId}-architecture-metrics.csv`);
  const reportPath = resolve(outputDirectory, `${runId}-architecture-report.md`);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8'),
    writeFile(csvPath, csv(results), 'utf8'),
    writeFile(reportPath, markdown(results, passed), 'utf8'),
  ]);
  process.stdout.write(`\n${passed ? 'PASS' : 'FAIL'} architecture hypothesis\n${jsonPath}\n${csvPath}\n${reportPath}\n`);
  if (!passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
