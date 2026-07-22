import { summarize } from './statistics.js';
import type {
  AggregateSummary,
  AuctionKind,
  HypothesisVerdict,
  Transport,
  TrialResult,
} from './research.types.js';

export function aggregateTrials(trials: TrialResult[], seed: number): AggregateSummary[] {
  const groups = new Map<string, { transport: Transport; trials: TrialResult[] }>();
  trials.forEach((trial) => {
    trial.transports.forEach((transport) => {
      const key = `${trial.config.name}:${trial.config.auctionKind}:${transport.transport}`;
      const group = groups.get(key) ?? { transport: transport.transport, trials: [] };
      group.trials.push(trial);
      groups.set(key, group);
    });
  });

  return [...groups.values()].map(({ transport: transportName, trials: group }, groupIndex) => {
    const first = group[0]!;
    const summaries = group.map(
      (trial) => trial.transports.find((transport) => transport.transport === transportName)!,
    );
    const totalClients = summaries.reduce((sum, summary) => sum + summary.clientCount, 0);
    const expectedEvents = group.reduce(
      (sum, trial) => sum + trial.authoritativeEventCount * first.config.clientsPerTransport,
      0,
    );
    return {
      scenario: first.config.name,
      auctionKind: first.config.auctionKind,
      transport: transportName,
      trials: group.length,
      clientCount: totalClients,
      winnerCorrectRate:
        group.filter((trial) => trial.winnerCorrect).length / Math.max(1, group.length),
      convergedClientRate:
        summaries.reduce((sum, summary) => sum + summary.convergedClients, 0) /
        Math.max(1, totalClients),
      missingEventRate:
        summaries.reduce((sum, summary) => sum + summary.missingEvents, 0) /
        Math.max(1, expectedEvents),
      latencyMs: summarize(
        summaries.map((summary) => summary.p95LatencyMs),
        seed + groupIndex * 17,
      ),
      recoveryMs: summarize(
        summaries.map((summary) => summary.p95RecoveryMs),
        seed + groupIndex * 31,
      ),
      payloadBytesPerClient: summarize(
        summaries.map((summary) => summary.payloadBytesPerClient),
        seed + groupIndex * 47,
      ),
    };
  });
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function metric(value: number | null): string {
  return value === null ? '—' : String(value);
}

export function markdownReport(
  runId: string,
  profile: string,
  repeats: number,
  verdicts: HypothesisVerdict[],
  aggregates: AggregateSummary[],
  trials: TrialResult[],
): string {
  const verdictRows = verdicts.map(
    (verdict) =>
      `| ${verdict.id} | ${verdict.title} | ${verdict.status} | ${verdict.evidence} |`,
  );
  const aggregateRows = aggregates.map(
    (aggregate) =>
      `| ${aggregate.scenario} | ${aggregate.auctionKind} | ${aggregate.transport} | ${aggregate.trials} | ${percent(aggregate.convergedClientRate)} | ${percent(aggregate.missingEventRate)} | ${metric(aggregate.latencyMs.mean)} [${metric(aggregate.latencyMs.meanCi95Low)}; ${metric(aggregate.latencyMs.meanCi95High)}] | ${metric(aggregate.recoveryMs.p95)} | ${metric(aggregate.payloadBytesPerClient.mean)} |`,
  );
  const scenarioRows = [...new Map(trials.map((trial) => [trial.config.name, trial.config])).values()].map(
    (config) =>
      `| ${config.name} | ${config.clientsPerTransport} | ${config.bidCount} | ${config.concurrency} | ${config.pollIntervalMs} | ${config.networkLatencyMs} ± ${config.networkJitterMs} | ${config.disconnectDurationMs || 'нет'} | ${Math.round(config.duplicateRate * 100)}% |`,
  );
  const notificationRows = trials.map(
    (trial) =>
      `| ${trial.config.trialId} | ${trial.notifications.telegramDelivered}/${trial.notifications.total} | ${trial.notifications.telegramRetried} | ${trial.notifications.miniAppLive} | ${trial.notifications.miniAppReplayed} | ${trial.notifications.miniAppMissing} | ${trial.notifications.miniAppCausalViolations} | ${metric(trial.notifications.p95TelegramDeliveryMs)} | ${metric(trial.notifications.p95MiniAppDisplayLatencyMs)} |`,
  );

  return [
    '# Пилотная апробация экспериментального стенда TeleBid',
    '',
    `Идентификатор запуска: \`${runId}\`. Профиль: \`${profile}\`. Повторов каждой комбинации: ${repeats}.`,
    '',
    '## Цель',
    '',
    'Проверить работоспособность стенда для измерения корректности конкурентных торгов, задержки синхронизации браузерных клиентов, восстановления состояния после разрыва и двухканальной доставки уведомлений в Telegram Mini App и через бота.',
    '',
    '## Проверяемые гипотезы',
    '',
    '| ID | Формулировка | Пилотный результат | Наблюдение |',
    '| --- | --- | --- | --- |',
    ...verdictRows,
    '',
    '## Управляемые факторы',
    '',
    '| Сценарий | Клиентов на транспорт | Ставок | Параллельность | Polling, мс | Задержка ± jitter, мс | Разрыв, мс | Повторы команд |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...scenarioRows,
    '',
    'Каждая комбинация выполняется отдельно для прямого и обратного аукциона. Команды отправляются напрямую в API, а трафик наблюдающих клиентов проходит через Toxiproxy. В reconnect-сценариях торги принудительно завершаются, пока Mini App отключён: после восстановления клиент должен получить финальное состояние и уведомления по cursor, а симулятор Bot API отклоняет первую попытку доставки и принимает retry.',
    '',
    '## Агрегированные результаты',
    '',
    '| Сценарий | Вид торгов | Транспорт | Прогонов | Сошлись клиенты | Пропущено событий | Среднее trial-p95, мс [bootstrap 95% CI] | p95 восстановления, мс | Средний payload/клиент, байт |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...aggregateRows,
    '',
    '## Telegram Mini App и уведомления',
    '',
    '| Trial | Бот доставил | Retry | Mini App live | Mini App replay | Потеряно | Нарушения порядка | p95 Bot API, мс | p95 показа, мс |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...notificationRows,
    '',
    'Статус доставки бота читается из сохраняемой записи уведомления. Исследовательский контур использует детерминированный адаптер Telegram Bot API с искусственным первым отказом; продуктовый контур использует тот же dispatcher с реальным Bot API. Mini App применяет дедупликацию по `notificationId`, cursor по `sequence` и показывает уведомление только после достижения связанной `aggregateVersion` состояния торгов.',
    '',
    '## Интерпретация',
    '',
    'Статусы показывают поддержку гипотез в пилотной серии, но не являются доказательством статистической значимости. НИР-2 фиксирует стенд, методику и начальный датасет. Увеличение числа повторов, статистические тесты различий и итоговые рекомендации относятся к НИР-3.',
    '',
    'Сравнение объёма трафика учитывает JSON payload прикладного уровня без заголовков HTTP, TLS и служебных WebSocket-фреймов. Это ограничение должно сохраняться одинаковым во всех дальнейших сериях.',
    '',
    '## Состав датасета',
    '',
    '- `events.csv` — получение каждого доменного события каждым клиентом;',
    '- `commands.csv` — каждая исходная и повторная попытка ставки;',
    '- `notifications.csv` — live/replay-доставка уведомлений в модель Mini App и момент их безопасного показа;',
    '- `clients.csv` — итоговые показатели каждого виртуального браузера;',
    '- `trials.csv` — показатели транспорта в каждом прогоне;',
    '- `aggregates.csv` — описательная статистика серий;',
    '- `summary.json` — полные результаты без сырых строк;',
    '- `manifest.json` — версия среды и параметры воспроизводимости.',
    '',
  ].join('\n');
}

export function aggregateCsvRows(aggregates: AggregateSummary[]): Record<string, unknown>[] {
  return aggregates.map((aggregate) => ({
    scenario: aggregate.scenario,
    auctionKind: aggregate.auctionKind,
    transport: aggregate.transport,
    trials: aggregate.trials,
    clientCount: aggregate.clientCount,
    winnerCorrectRate: aggregate.winnerCorrectRate,
    convergedClientRate: aggregate.convergedClientRate,
    missingEventRate: aggregate.missingEventRate,
    latencyCount: aggregate.latencyMs.count,
    latencyMeanMs: aggregate.latencyMs.mean,
    latencyMedianMs: aggregate.latencyMs.median,
    latencyP95Ms: aggregate.latencyMs.p95,
    latencyStdDevMs: aggregate.latencyMs.standardDeviation,
    latencyMeanCi95LowMs: aggregate.latencyMs.meanCi95Low,
    latencyMeanCi95HighMs: aggregate.latencyMs.meanCi95High,
    recoveryP95Ms: aggregate.recoveryMs.p95,
    payloadBytesPerClientMean: aggregate.payloadBytesPerClient.mean,
  }));
}

export function trialCsvRows(trials: TrialResult[]): Record<string, unknown>[] {
  return trials.flatMap((trial) =>
    trial.transports.map((transport) => ({
      runId: trial.config.runId,
      trialId: trial.config.trialId,
      scenario: trial.config.name,
      repetition: trial.config.repetition,
      seed: trial.config.seed,
      auctionKind: trial.config.auctionKind,
      transport: transport.transport,
      clientsPerTransport: trial.config.clientsPerTransport,
      bidCount: trial.config.bidCount,
      concurrency: trial.config.concurrency,
      commandIntervalMs: trial.config.commandIntervalMs,
      pollIntervalMs: trial.config.pollIntervalMs,
      networkLatencyMs: trial.config.networkLatencyMs,
      networkJitterMs: trial.config.networkJitterMs,
      disconnectDurationMs: trial.config.disconnectDurationMs,
      duplicateRate: trial.config.duplicateRate,
      durationMs: trial.durationMs,
      winnerCorrect: trial.winnerCorrect ? 1 : 0,
      eventSequenceContinuous: trial.eventSequenceContinuous ? 1 : 0,
      acceptedCommands: trial.acceptedCommands,
      rejectedCommands: trial.rejectedCommands,
      duplicateAttempts: trial.duplicateAttempts,
      idempotentReplays: trial.idempotentReplays,
      duplicateCommandEffects: trial.duplicateCommandEffects,
      authoritativeEventCount: trial.authoritativeEventCount,
      clientCount: transport.clientCount,
      convergedClients: transport.convergedClients,
      staleClients: transport.staleClients,
      missingEvents: transport.missingEvents,
      duplicateDeliveries: transport.duplicateDeliveries,
      clientsWithObservedGaps: transport.clientsWithObservedGaps,
      payloadBytes: transport.payloadBytes,
      payloadBytesPerClient: transport.payloadBytesPerClient,
      requests: transport.requests,
      failedRequests: transport.failedRequests,
      reconnects: transport.reconnects,
      p50LatencyMs: transport.p50LatencyMs,
      p95LatencyMs: transport.p95LatencyMs,
      maxLatencyMs: transport.maxLatencyMs,
      p95RecoveryMs: transport.p95RecoveryMs,
      notificationsTotal: trial.notifications.total,
      telegramDelivered: trial.notifications.telegramDelivered,
      telegramRetried: trial.notifications.telegramRetried,
      p95TelegramDeliveryMs: trial.notifications.p95TelegramDeliveryMs,
      miniAppExpected: trial.notifications.miniAppExpected,
      miniAppReceived: trial.notifications.miniAppReceived,
      miniAppLive: trial.notifications.miniAppLive,
      miniAppReplayed: trial.notifications.miniAppReplayed,
      miniAppMissing: trial.notifications.miniAppMissing,
      miniAppDuplicates: trial.notifications.miniAppDuplicates,
      miniAppCausalViolations: trial.notifications.miniAppCausalViolations,
      p95MiniAppDisplayLatencyMs: trial.notifications.p95MiniAppDisplayLatencyMs,
    })),
  );
}

export function clientCsvRows(trials: TrialResult[]): Record<string, unknown>[] {
  return trials.flatMap((trial) =>
    trial.clients.map((client) => ({
      runId: trial.config.runId,
      trialId: trial.config.trialId,
      scenario: trial.config.name,
      repetition: trial.config.repetition,
      auctionKind: trial.config.auctionKind,
      clientId: client.clientId,
      transport: client.transport,
      received: client.received,
      missing: client.missing,
      duplicateDeliveries: client.duplicateDeliveries,
      observedVersionGaps: client.observedVersionGaps,
      payloadBytes: client.payloadBytes,
      requests: client.requests,
      failedRequests: client.failedRequests,
      reconnects: client.reconnects,
      p50LatencyMs: client.p50LatencyMs,
      p95LatencyMs: client.p95LatencyMs,
      maxLatencyMs: client.maxLatencyMs,
      finalVersion: client.finalVersion,
      converged: client.converged ? 1 : 0,
      recoveryMs: client.recoveryMs,
    })),
  );
}

export function stripRawRows(
  trial: TrialResult,
): Omit<TrialResult, 'eventRows' | 'commandRows' | 'notificationRows'> {
  const {
    eventRows: ignoredEvents,
    commandRows: ignoredCommands,
    notificationRows: ignoredNotifications,
    ...summary
  } = trial;
  return summary;
}

export type AggregateKey = `${string}:${AuctionKind}:${Transport}`;
