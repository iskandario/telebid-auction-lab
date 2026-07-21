export interface TransportEvidence {
  transport: 'polling' | 'sse' | 'websocket';
  received: number;
  missing: number;
  duplicates: number;
  gaps: number;
  bytes: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  maxLatencyMs: number | null;
  finalVersion: number;
}

export interface RecoveryEvidence {
  sinceVersion: number;
  serverVersion: number;
  snapshotBytes: number;
  replayBytes: number;
  hybridBytes: number;
  hybridMode: 'snapshot' | 'events';
  expectedHybridMode: 'snapshot' | 'events';
  sameFinalVersion: boolean;
  replayContinuous: boolean;
}

export interface ScenarioEvidence {
  kind: 'DIRECT' | 'REVERSE';
  commands: { accepted: number; rejected: number };
  authoritativeEventCount: number;
  transports: TransportEvidence[];
  notifications: {
    total: number;
    duplicates: number;
    orphaned: number;
    afterCursorCount: number;
    p95LatencyMs: number | null;
  };
  recovery: RecoveryEvidence;
}

export interface HypothesisVerdict {
  id: 'H1' | 'H2' | 'H3' | 'H4';
  title: string;
  passed: boolean;
  criterion: string;
  evidence: string;
}

function transport(scenario: ScenarioEvidence, name: TransportEvidence['transport']) {
  return scenario.transports.find((item) => item.transport === name);
}

export function evaluateHypotheses(scenarios: ScenarioEvidence[]): HypothesisVerdict[] {
  const stateConsistent = scenarios.every((scenario) => {
    const expectedFinalVersion = 1 + scenario.authoritativeEventCount;
    return (
      scenario.commands.accepted === scenario.authoritativeEventCount &&
      scenario.transports.every(
        (item) => item.missing === 0 && item.gaps === 0 && item.finalVersion === expectedFinalVersion,
      )
    );
  });

  const realtimeFaster = scenarios.every((scenario) => {
    const polling = transport(scenario, 'polling')?.p95LatencyMs;
    const sse = transport(scenario, 'sse')?.p95LatencyMs;
    const websocket = transport(scenario, 'websocket')?.p95LatencyMs;
    return (
      polling !== null &&
      polling !== undefined &&
      sse !== null &&
      sse !== undefined &&
      websocket !== null &&
      websocket !== undefined &&
      sse < polling &&
      websocket < polling
    );
  });

  const recoveryCorrect = scenarios.every(
    (scenario) =>
      scenario.recovery.sameFinalVersion &&
      scenario.recovery.replayContinuous &&
      scenario.recovery.hybridMode === scenario.recovery.expectedHybridMode,
  );

  const notificationsCorrect = scenarios.every(
    (scenario) =>
      scenario.notifications.total > 0 &&
      scenario.notifications.duplicates === 0 &&
      scenario.notifications.orphaned === 0 &&
      scenario.notifications.afterCursorCount === 0,
  );

  return [
    {
      id: 'H1',
      title: 'Конкурентные команды не нарушают состояние торгов',
      passed: stateConsistent,
      criterion: 'Число принятых команд совпадает с журналом; у всех клиентов нет пропусков и совпадает итоговая версия.',
      evidence: scenarios
        .map(
          (scenario) =>
            `${scenario.kind}: accepted=${scenario.commands.accepted}, events=${scenario.authoritativeEventCount}, missing=${scenario.transports.reduce((sum, item) => sum + item.missing, 0)}`,
        )
        .join('; '),
    },
    {
      id: 'H2',
      title: 'Push-транспорты быстрее polling для live-обновлений',
      passed: realtimeFaster,
      criterion: 'p95 задержки SSE и WebSocket ниже p95 периодических HTTP-запросов в обоих сценариях.',
      evidence: scenarios
        .map(
          (scenario) =>
            `${scenario.kind}: polling=${transport(scenario, 'polling')?.p95LatencyMs ?? '—'}ms, SSE=${transport(scenario, 'sse')?.p95LatencyMs ?? '—'}ms, WS=${transport(scenario, 'websocket')?.p95LatencyMs ?? '—'}ms`,
        )
        .join('; '),
    },
    {
      id: 'H3',
      title: 'Гибридное восстановление возвращает актуальное состояние меньшим объёмом',
      passed: recoveryCorrect,
      criterion: 'Snapshot и replay сходятся к одной версии, replay непрерывен, hybrid выбирает меньший payload.',
      evidence: scenarios
        .map(
          (scenario) =>
            `${scenario.kind}: snapshot=${scenario.recovery.snapshotBytes}B, replay=${scenario.recovery.replayBytes}B, hybrid=${scenario.recovery.hybridMode}`,
        )
        .join('; '),
    },
    {
      id: 'H4',
      title: 'Уведомления восстанавливаются без дубликатов и нарушения причинности',
      passed: notificationsCorrect,
      criterion: 'Уведомления сохранены, уникальны и каждое ссылается на существующее доменное событие.',
      evidence: scenarios
        .map(
          (scenario) =>
            `${scenario.kind}: total=${scenario.notifications.total}, duplicates=${scenario.notifications.duplicates}, orphaned=${scenario.notifications.orphaned}, afterCursor=${scenario.notifications.afterCursorCount}`,
        )
        .join('; '),
    },
  ];
}
