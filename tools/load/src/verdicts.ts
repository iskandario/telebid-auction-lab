import { percentile } from './statistics.js';
import type { HypothesisVerdict, Transport, TrialResult } from './research.types.js';

function status(passed: boolean, hasEvidence = true): HypothesisVerdict['status'] {
  if (!hasEvidence) return 'INCONCLUSIVE';
  return passed ? 'SUPPORTED' : 'NOT_SUPPORTED';
}

function transportP95(trial: TrialResult, transport: Transport): number | null {
  return trial.transports.find((item) => item.transport === transport)?.p95LatencyMs ?? null;
}

export function evaluateHypotheses(trials: TrialResult[]): HypothesisVerdict[] {
  const tradeCorrect = trials.every(
    (trial) =>
      trial.winnerCorrect &&
      trial.eventSequenceContinuous &&
      trial.duplicateCommandEffects === 0 &&
      trial.idempotentReplays === trial.duplicateAttempts,
  );

  const liveTrials = trials.filter((trial) => trial.config.disconnectAfterFraction === null);
  const liveGroups = new Map<string, TrialResult[]>();
  liveTrials.forEach((trial) => {
    const key = `${trial.config.name}:${trial.config.auctionKind}`;
    liveGroups.set(key, [...(liveGroups.get(key) ?? []), trial]);
  });
  const latencyComparisons = [...liveGroups.entries()].map(([key, group]) => {
    const polling = percentile(
      group.map((trial) => transportP95(trial, 'polling')).filter((value): value is number => value !== null),
      0.5,
    );
    const sse = percentile(
      group.map((trial) => transportP95(trial, 'sse')).filter((value): value is number => value !== null),
      0.5,
    );
    const websocket = percentile(
      group.map((trial) => transportP95(trial, 'websocket')).filter((value): value is number => value !== null),
      0.5,
    );
    return {
      key,
      polling,
      sse,
      websocket,
      passed:
        polling !== null &&
        sse !== null &&
        websocket !== null &&
        sse < polling &&
        websocket < polling,
    };
  });
  const pushFaster =
    latencyComparisons.length > 0 && latencyComparisons.every((comparison) => comparison.passed);

  const reconnectTrials = trials.filter((trial) => trial.config.disconnectAfterFraction !== null);
  const recoveryCorrect = reconnectTrials.every((trial) =>
    trial.transports.every(
      (transport) =>
        transport.staleClients === 0 &&
        transport.missingEvents === 0 &&
        transport.p95RecoveryMs !== null &&
        transport.p95RecoveryMs <= trial.config.convergenceTimeoutMs,
    ),
  );

  const hybridCorrect = trials.every(
    (trial) =>
      trial.recovery.sameFinalVersion &&
      trial.recovery.replayContinuous &&
      trial.recovery.hybridMode === trial.recovery.expectedHybridMode &&
      trial.recovery.hybridBytes ===
        Math.min(trial.recovery.snapshotBytes, trial.recovery.replayBytes),
  );

  const notificationsCorrect = trials.every(
    (trial) =>
      trial.notifications.total > 0 &&
      trial.notifications.duplicates === 0 &&
      trial.notifications.orphaned === 0 &&
      trial.notifications.afterCursorCount === 0 &&
      trial.notifications.telegramDelivered === trial.notifications.total &&
      trial.notifications.telegramPending === 0 &&
      trial.notifications.telegramFailed === 0 &&
      trial.notifications.telegramSkipped === 0 &&
      trial.notifications.telegramRetried > 0 &&
      trial.notifications.miniAppExpected > 0 &&
      trial.notifications.miniAppReceived === trial.notifications.miniAppExpected &&
      trial.notifications.miniAppMissing === 0 &&
      trial.notifications.miniAppDuplicates === 0 &&
      trial.notifications.miniAppCausalViolations === 0,
  );

  return [
    {
      id: 'H1',
      title: 'Конкурентные ставки сохраняют корректный результат торгов',
      status: status(tradeCorrect, trials.length > 0),
      criterion:
        'Во всех прогонах правильны цена и победитель, версии событий непрерывны, а повтор commandId не создаёт второй эффект.',
      evidence: `${trials.filter((trial) => trial.winnerCorrect).length}/${trials.length} правильных результатов; ${trials.reduce((sum, trial) => sum + trial.duplicateCommandEffects, 0)} повторных эффектов; ${trials.reduce((sum, trial) => sum + trial.idempotentReplays, 0)}/${trials.reduce((sum, trial) => sum + trial.duplicateAttempts, 0)} повторов распознано.`,
    },
    {
      id: 'H2',
      title: 'SSE и WebSocket уменьшают задержку live-обновлений относительно polling',
      status: status(pushFaster, latencyComparisons.length > 0),
      criterion:
        'В сценариях без разрыва медиана trial-p95 для SSE и WebSocket ниже медианы trial-p95 polling.',
      evidence:
        latencyComparisons
          .map(
            (comparison) =>
              `${comparison.key}: polling=${comparison.polling ?? '—'} мс, SSE=${comparison.sse ?? '—'} мс, WS=${comparison.websocket ?? '—'} мс`,
          )
          .join('; ') || 'Нет сценария без разрыва связи.',
    },
    {
      id: 'H3',
      title: 'Версионированное восстановление устраняет рассинхронизацию после reconnect',
      status: status(recoveryCorrect, reconnectTrials.length > 0),
      criterion:
        'После принудительного разрыва все клиенты достигают серверной версии без итоговых пропусков за отведённый тайм-аут.',
      evidence:
        reconnectTrials
          .map(
            (trial) =>
              `${trial.config.name}/${trial.config.auctionKind}/r${trial.config.repetition}: stale=${trial.transports.reduce((sum, item) => sum + item.staleClients, 0)}, missing=${trial.transports.reduce((sum, item) => sum + item.missingEvents, 0)}`,
          )
          .join('; ') || 'Нет сценария с разрывом связи.',
    },
    {
      id: 'H4',
      title: 'Hybrid recovery выбирает меньший корректный payload',
      status: status(hybridCorrect, trials.length > 0),
      criterion:
        'Snapshot и replay сходятся к одной версии; replay непрерывен; hybrid выбирает вариант с меньшим JSON payload.',
      evidence: `${trials.filter((trial) => trial.recovery.sameFinalVersion).length}/${trials.length} прогонов сошлись к одной версии; ${trials.filter((trial) => trial.recovery.hybridMode === trial.recovery.expectedHybridMode).length}/${trials.length} решений hybrid совпали с минимумом.`,
    },
    {
      id: 'H5',
      title: 'Двухканальные уведомления переживают закрытие Mini App и сбой Bot API',
      status: status(notificationsCorrect, trials.length > 0),
      criterion:
        'Уведомление атомарно связано с событием, доставлено ботом после искусственного первого отказа и ровно один раз показано Mini App после live/replay с соблюдением aggregateVersion.',
      evidence: `${trials.reduce((sum, trial) => sum + trial.notifications.telegramDelivered, 0)}/${trials.reduce((sum, trial) => sum + trial.notifications.total, 0)} доставлено ботом; ${trials.reduce((sum, trial) => sum + trial.notifications.telegramRetried, 0)} потребовали retry; Mini App получил ${trials.reduce((sum, trial) => sum + trial.notifications.miniAppReceived, 0)}/${trials.reduce((sum, trial) => sum + trial.notifications.miniAppExpected, 0)}, из них ${trials.reduce((sum, trial) => sum + trial.notifications.miniAppReplayed, 0)} через replay; ${trials.reduce((sum, trial) => sum + trial.notifications.miniAppCausalViolations, 0)} нарушений порядка.`,
    },
  ];
}
