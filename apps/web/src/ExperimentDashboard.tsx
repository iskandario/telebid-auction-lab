import { useCallback, useEffect, useRef, useState } from 'react';
import { runExperiment } from './api';
import type { AuctionKind } from './domain';
import type { ExperimentInput, ExperimentResult, ModeMetrics } from './experiment.types';

type LoadPreset = 'steady' | 'rush' | 'stress';
type NetworkPreset = 'stable' | 'mobile' | 'unstable';

const loadPresets: Record<LoadPreset, Pick<ExperimentInput, 'clients' | 'commands' | 'burstWindowMs'>> = {
  steady: { clients: 10, commands: 40, burstWindowMs: 2500 },
  rush: { clients: 30, commands: 120, burstWindowMs: 250 },
  stress: { clients: 100, commands: 500, burstWindowMs: 100 },
};

const networkPresets: Record<
  NetworkPreset,
  Pick<ExperimentInput, 'networkLatencyMs' | 'networkJitterMs' | 'disconnectRate' | 'duplicateRate'>
> = {
  stable: { networkLatencyMs: 20, networkJitterMs: 15, disconnectRate: 0.02, duplicateRate: 0.01 },
  mobile: { networkLatencyMs: 120, networkJitterMs: 180, disconnectRate: 0.2, duplicateRate: 0.12 },
  unstable: { networkLatencyMs: 300, networkJitterMs: 500, disconnectRate: 0.38, duplicateRate: 0.25 },
};

function formatMoney(value: number) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value) + ' ₽';
}

function formatPercent(value: number) {
  return `${value.toFixed(value < 10 && value % 1 ? 1 : 0)}%`;
}

function Metric({
  label,
  naive,
  reliable,
  hint,
}: {
  label: string;
  naive: number;
  reliable: number;
  hint: string;
}) {
  const improvement = naive > 0 ? Math.round(((naive - reliable) / naive) * 100) : 0;
  return (
    <div className="exp-metric-row">
      <div><strong>{label}</strong><span>{hint}</span></div>
      <b className={naive > reliable ? 'bad' : ''}>{formatPercent(naive)}</b>
      <b className={reliable < naive ? 'good' : ''}>{formatPercent(reliable)}</b>
      <i>{improvement > 0 ? `−${improvement}%` : 'без разницы'}</i>
    </div>
  );
}

function ArchitectureCard({ mode, metrics }: { mode: 'naive' | 'reliable'; metrics: ModeMetrics }) {
  const reliable = mode === 'reliable';
  return (
    <article className={`exp-architecture exp-architecture--${mode}`}>
      <header>
        <span>{reliable ? 'B' : 'A'}</span>
        <div>
          <p>{reliable ? 'Гибридная Telegram-архитектура' : 'Только активный Mini App'}</p>
          <h3>{reliable ? 'Атомарные ставки, replay и бот' : 'Параллельная запись и WebSocket'}</h3>
        </div>
        <i>{reliable ? 'ПРЕДЛАГАЕМАЯ' : 'БАЗОВАЯ'}</i>
      </header>
      <div className="exp-pipeline">
        {(reliable
          ? ['Ставки', 'Транзакция', 'Версия', 'Replay Mini App', 'Telegram-бот']
          : ['Ставки', 'Старая цена', 'Параллельная запись', 'Только WebSocket']
        ).map((step, index, steps) => (
          <span key={step}>{step}{index < steps.length - 1 && <b>→</b>}</span>
        ))}
      </div>
      <div className="exp-architecture-result">
        <div><span>Ошибочный победитель</span><strong>{formatPercent(metrics.incorrectWinnerRate)}</strong></div>
        <div><span>p95 команды</span><strong>{metrics.commandP95Ms} ms</strong></div>
        <div><span>Обработано команд</span><strong>{metrics.throughputPerSecond}/с</strong></div>
      </div>
    </article>
  );
}

function ResultSkeleton() {
  return (
    <div className="exp-running">
      <span><i /><i /><i /></span>
      <h2>Прогоняем одинаковые торги через две архитектуры</h2>
      <p>Участники одновременно ставят, сворачивают Mini App и повторяют запросы.</p>
    </div>
  );
}

export function ExperimentDashboard() {
  const [kind, setKind] = useState<AuctionKind>('DIRECT');
  const [loadPreset, setLoadPreset] = useState<LoadPreset>('rush');
  const [networkPreset, setNetworkPreset] = useState<NetworkPreset>('mobile');
  const [result, setResult] = useState<ExperimentResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runNumber = useRef(0);
  const initialRun = useRef(false);

  const execute = useCallback(async () => {
    setRunning(true);
    setError(null);
    runNumber.current += 1;
    const input: ExperimentInput = {
      kind,
      ...loadPresets[loadPreset],
      ...networkPresets[networkPreset],
      trials: loadPreset === 'stress' ? 25 : 40,
      seed: 506911 + runNumber.current,
    };
    try {
      const next = await runExperiment(input);
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      setResult(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Эксперимент не запустился');
    } finally {
      setRunning(false);
    }
  }, [kind, loadPreset, networkPreset]);

  useEffect(() => {
    if (initialRun.current) return;
    initialRun.current = true;
    void execute();
  }, [execute]);

  const sampleHasWinnerError = Boolean(
    result &&
      (result.sample.naivePrice !== result.sample.idealPrice ||
        result.sample.naiveWinnerId !== result.sample.idealWinnerId),
  );

  return (
    <div className="experiment-app">
      <header className="exp-header">
        <a href="/" className="exp-brand"><span><i /><i /><i /></span><strong>TeleBid Lab</strong></a>
        <p>Эксперимент Telegram Mini App под нагрузкой</p>
        <a href="/" className="exp-demo-link">Открыть Mini App ↗</a>
      </header>

      <main className="exp-main">
        <section className="exp-hero">
          <div>
            <span className="exp-kicker">Один поток событий · две веб-архитектуры</span>
            <h1>Что произойдёт, если свернуть Mini App во время торгов?</h1>
            <p>Ставка может столкнуться с другой ставкой, экран отстать после reconnect, а уведомление потеряться вместе с WebSocket. Стенд воспроизводит все три сбоя одновременно.</p>
          </div>
          <aside>
            <span>Гипотеза</span>
            <p>Атомарная обработка команд, версии событий, replay после reconnect и сохраняемая доставка через Telegram-бота уменьшат ошибки победителя, устаревшие экраны и потерянные уведомления.</p>
          </aside>
        </section>

        <section className="exp-controls">
          <div className="exp-control-group">
            <span>Правило выбора победителя</span>
            <div className="exp-segmented">
              <button className={kind === 'DIRECT' ? 'active' : ''} onClick={() => setKind('DIRECT')}>Побеждает максимум</button>
              <button className={kind === 'REVERSE' ? 'active' : ''} onClick={() => setKind('REVERSE')}>Побеждает минимум</button>
            </div>
          </div>
          <div className="exp-control-group">
            <span>Сколько ставок приходит одновременно</span>
            <div className="exp-segmented">
              <button className={loadPreset === 'steady' ? 'active' : ''} onClick={() => setLoadPreset('steady')}>Мало</button>
              <button className={loadPreset === 'rush' ? 'active' : ''} onClick={() => setLoadPreset('rush')}>Много в финале</button>
              <button className={loadPreset === 'stress' ? 'active' : ''} onClick={() => setLoadPreset('stress')}>Очень много</button>
            </div>
          </div>
          <div className="exp-control-group">
            <span>Связь пользователей Mini App</span>
            <div className="exp-segmented">
              <button className={networkPreset === 'stable' ? 'active' : ''} onClick={() => setNetworkPreset('stable')}>Стабильная</button>
              <button className={networkPreset === 'mobile' ? 'active' : ''} onClick={() => setNetworkPreset('mobile')}>Мобильная</button>
              <button className={networkPreset === 'unstable' ? 'active' : ''} onClick={() => setNetworkPreset('unstable')}>Нестабильная</button>
            </div>
          </div>
          <button className="exp-run-button" onClick={() => void execute()} disabled={running}>
            {running ? 'Боты делают ставки…' : 'Запустить торги'}<span>→</span>
          </button>
        </section>

        <section className="exp-config-line">
          <span>① {loadPresets[loadPreset].clients} участников</span>
          <span>② {loadPresets[loadPreset].commands} ставок</span>
          <span>③ все за {loadPresets[loadPreset].burstWindowMs} мс</span>
          <span>④ {Math.round(networkPresets[networkPreset].disconnectRate * 100)}% теряют связь</span>
          <span>⑤ {Math.round(networkPresets[networkPreset].duplicateRate * 100)}% запросов повторяются</span>
          <span>⑥ опыт повторяется {loadPreset === 'stress' ? 25 : 40} раз</span>
        </section>

        {running && <ResultSkeleton />}
        {error && <div className="exp-error">{error}</div>}

        {!running && result && (
          <>
            <section className={`exp-verdict exp-verdict--${result.verdict.status.toLowerCase()}`}>
              <span>{result.verdict.status === 'SUPPORTED' ? '✓' : '!'}</span>
              <div>
                <p>Ответ на вопрос исследования</p>
                <h2>{result.verdict.status === 'SUPPORTED' ? 'Гибридная архитектура предотвращает наблюдаемые ошибки' : 'Преимущество архитектуры не доказано'}</h2>
                <strong>{result.verdict.explanation}</strong>
              </div>
              <aside>
                <small>Улучшено показателей</small>
                <b>{result.verdict.passedChecks}/{result.verdict.totalChecks}</b>
                <span>seed {result.config.seed}</span>
              </aside>
            </section>

            <section className="exp-architectures">
              <ArchitectureCard mode="naive" metrics={result.naive} />
              <div className="exp-versus">VS</div>
              <ArchitectureCard mode="reliable" metrics={result.reliable} />
            </section>

            <section className="exp-comparison">
              <header>
                <div><span>Что проверяем</span><strong>Когда засчитывается ошибка</strong></div>
                <span>ТОЛЬКО WS</span><span>MINI APP + БОТ</span><span>РЕЗУЛЬТАТ</span>
              </header>
              <Metric label="Неверный результат торгов" hint="Финальный лидер не совпал с лучшим допустимым предложением" naive={result.naive.incorrectWinnerRate} reliable={result.reliable.incorrectWinnerRate} />
              <Metric label="Устаревшее состояние Mini App" hint="После reconnect участник видит не ту цену или не того лидера" naive={result.naive.inconsistentClientRate} reliable={result.reliable.inconsistentClientRate} />
              <Metric label="Пропущенные уведомления" hint="При закрытом Mini App не доставлено сообщение о перебитой ставке или результате" naive={result.naive.missedNotificationRate} reliable={result.reliable.missedNotificationRate} />
              <Metric label="Двойное выполнение ставки" hint="Повторная отправка одного запроса второй раз изменила торги" naive={result.naive.duplicateCommandEffectRate} reliable={result.reliable.duplicateCommandEffectRate} />
            </section>

            <section className="exp-sample">
              <div className="exp-sample-heading">
                <div>
                  <span>{sampleHasWinnerError ? 'Конкретный сбой из этого запуска' : 'Один наблюдаемый прогон'}</span>
                  <h2>{sampleHasWinnerError ? 'Как сервер без защиты потерял правильный результат' : 'В этом прогоне победитель совпал, проверяем остальные ошибки'}</h2>
                </div>
                <div className="exp-winners">
                  <span>Правильный ответ <b>{result.sample.idealWinnerId} · {formatMoney(result.sample.idealPrice)}</b></span>
                  <span className={result.sample.naivePrice === result.sample.idealPrice ? 'correct' : 'wrong'}>Только WebSocket <b>{result.sample.naiveWinnerId} · {formatMoney(result.sample.naivePrice)}</b></span>
                  <span className="correct">Mini App + бот <b>{result.sample.reliableWinnerId} · {formatMoney(result.sample.reliablePrice)}</b></span>
                </div>
              </div>
              <div className="exp-timeline">
                {result.sample.timeline.map((point) => (
                  <article key={point.command}>
                    <span>#{point.command}</span>
                    <div><strong>{point.participantId}</strong><small>{formatMoney(point.amount)}</small></div>
                    <i className={point.naive.accepted ? 'accepted' : ''}>A: {point.naive.accepted ? 'принята' : 'отклонена'}</i>
                    <i className={point.reliable.accepted ? 'accepted' : ''}>B: {point.reliable.accepted ? 'принята' : 'отклонена'}</i>
                  </article>
                ))}
              </div>
            </section>

            <section className="exp-tradeoff">
              <div><span>Компромисс</span><h2>За правильность платим временем</h2><p>Очередь не даёт ставкам затереть друг друга, но во время всплеска каждой следующей ставке приходится ждать. Поэтому сравниваем не только ошибки, но и задержку.</p></div>
              <article><span>Базовая, p95</span><strong>{result.naive.commandP95Ms} мс</strong></article>
              <article><span>Гибридная, p95</span><strong>{result.reliable.commandP95Ms} мс</strong></article>
              <article className="accent"><span>Изменение p95</span><strong>{result.verdict.latencyOverheadMs > 0 ? '+' : ''}{result.verdict.latencyOverheadMs} мс</strong></article>
            </section>
          </>
        )}
      </main>

      <footer className="exp-footer">
        <span>TeleBid Lab / воспроизводимый эксперимент</span>
        <span>Одинаковые входные данные для A и B</span>
        <span>TypeScript · Telegram Mini Apps · NestJS · PostgreSQL</span>
      </footer>
    </div>
  );
}
