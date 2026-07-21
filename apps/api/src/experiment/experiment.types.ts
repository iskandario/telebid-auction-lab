import { AuctionKind } from '../common/domain.types';

export interface ExperimentConfig {
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

export interface ModeMetrics {
  incorrectWinnerRate: number;
  inconsistentClientRate: number;
  missedNotificationRate: number;
  duplicateCommandEffectRate: number;
  commandP95Ms: number;
  throughputPerSecond: number;
  acceptedCommandsAverage: number;
}

export interface TimelinePoint {
  command: number;
  participantId: string;
  amount: number;
  arrivalAtMs: number;
  naive: {
    accepted: boolean;
    stateAfter: number;
  };
  reliable: {
    accepted: boolean;
    stateAfter: number;
  };
}

export interface ExperimentResult {
  experimentId: string;
  generatedAt: string;
  hypothesis: string;
  config: ExperimentConfig;
  naive: ModeMetrics;
  reliable: ModeMetrics;
  verdict: {
    status: 'SUPPORTED' | 'NOT_SUPPORTED' | 'INCONCLUSIVE';
    passedChecks: number;
    totalChecks: number;
    latencyOverheadMs: number;
    latencyOverheadPercent: number;
    explanation: string;
  };
  sample: {
    idealWinnerId: string;
    idealPrice: number;
    naiveWinnerId: string | null;
    naivePrice: number;
    reliableWinnerId: string | null;
    reliablePrice: number;
    timeline: TimelinePoint[];
  };
}
