# Схема датасета TeleBid

Все CSV используют UTF-8, строку заголовков и запятую как разделитель. Значения экранируются двойными кавычками. Время записывается в ISO 8601 UTC, длительность — в миллисекундах, объём — в байтах JSON payload.

## Общие идентификаторы

- `runId` — идентификатор полной серии.
- `trialId` — идентификатор одного прогона.
- `scenario` — профиль сетевых и нагрузочных условий.
- `repetition` — номер повтора комбинации.
- `auctionKind` — `DIRECT` или `REVERSE`.
- `seed` — seed генерации идентификаторов входных команд.

## events.csv

Одна строка соответствует одной доставке доменного события одному виртуальному браузеру.

- `clientId`, `transport` — клиент и способ синхронизации.
- `eventId`, `eventType`, `aggregateVersion` — идентификатор, тип и версия события.
- `serverTimestamp`, `receivedAt` — серверное создание и клиентское получение.
- `latencyMs` — разность двух времён.
- `payloadBytes` — учтённый payload события; для события внутри polling/replay равен нулю, потому что полный ответ уже учитывается на уровне клиента.
- `duplicateDelivery` — событие уже было применено клиентом.
- `observedVersionGap` — при получении замечен скачок версии больше единицы.

## commands.csv

Одна строка соответствует одной HTTP-попытке торговой команды.

- `commandId` — идемпотентный идентификатор команды.
- `attempt` — `1` для исходной отправки, `2` для намеренного повтора.
- `participantId`, `amount` — участник и предложение.
- `startedAt`, `completedAt`, `latencyMs` — границы обработки.
- `httpStatus`, `accepted`, `errorCode` — результат HTTP-запроса.
- `idempotentReplay` — сервер вернул сохранённый результат без нового изменения.
- `responseVersion` — версия состояния в ответе.

## clients.csv

Одна строка соответствует одному виртуальному браузеру по итогам trial.

- `received`, `missing` — число уникальных полученных и итогово пропущенных событий.
- `duplicateDeliveries`, `observedVersionGaps` — наблюдавшиеся повторы и разрывы последовательности.
- `payloadBytes`, `requests`, `failedRequests`, `reconnects` — нагрузка и сетевые события.
- `p50LatencyMs`, `p95LatencyMs`, `maxLatencyMs` — распределение задержки доставки.
- `finalVersion`, `converged` — итоговая версия и совпадение с сервером.
- `recoveryMs` — время от восстановления прокси до достижения серверной версии.

## notifications.csv

Одна строка соответствует получению сохраняемого уведомления моделью активного или повторно открытого Telegram Mini App.

- `recipientId`, `notificationId`, `sequence`, `kind` — адресат, идентификатор, cursor и тип уведомления.
- `aggregateVersion` — версия торгов, с которой причинно связано уведомление.
- `source` — `live` для активного WebSocket или `replay` для восстановления из durable inbox.
- `createdAt`, `receivedAt`, `latencyMs` — создание в транзакции и получение Mini App.
- `stateVersionAtReceipt` — версия состояния клиента в момент получения.
- `displayedAt`, `displayLatencyMs` — момент показа после достижения связанной версии.
- `duplicateDelivery` — повторная доставка уже известного `notificationId`.
- `causalOrderViolation` — уведомление пришло раньше состояния вне фазы синхронизации.

## trials.csv

Одна строка соответствует одному транспорту в одном trial. Таблица объединяет конфигурацию, корректность торгов и агрегированные показатели всех клиентов этого транспорта.

Ключевые поля: `winnerCorrect`, `eventSequenceContinuous`, `duplicateCommandEffects`, `staleClients`, `missingEvents`, `payloadBytesPerClient`, `p95LatencyMs`, `p95RecoveryMs`, `telegramDelivered`, `telegramRetried`, `miniAppReplayed`, `miniAppMissing`.

## aggregates.csv

Одна строка соответствует комбинации сценария, вида торгов и транспорта по всем повторам.

- `winnerCorrectRate`, `convergedClientRate`, `missingEventRate` — долевые показатели от 0 до 1.
- `latencyMeanMs`, `latencyMedianMs`, `latencyP95Ms`, `latencyStdDevMs` — описательная статистика trial-p95.
- `latencyMeanCi95LowMs`, `latencyMeanCi95HighMs` — bootstrap 95% интервал среднего trial-p95.
- `recoveryP95Ms` — p95 итоговых trial-p95 восстановления.
- `payloadBytesPerClientMean` — средний прикладной payload на клиента.

## manifest.json и summary.json

`manifest.json` фиксирует версию схемы, параметры запуска, среду Node/CPU, Git revision, адреса изолированного стенда и версию Toxiproxy.

`summary.json` содержит вердикты гипотез, агрегаты и полные результаты trial без дублирования сырых строк событий, команд и уведомлений.
