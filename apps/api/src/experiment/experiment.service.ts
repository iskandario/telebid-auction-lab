import { Injectable } from '@nestjs/common';
import { AuctionKind } from '../common/domain.types';
import type { ExperimentConfig, ExperimentResult } from './experiment.types';
import { runArchitectureExperiment } from './experiment.simulator';
import type { RunExperimentDto } from './run-experiment.dto';

@Injectable()
export class ExperimentService {
  run(dto: RunExperimentDto): ExperimentResult {
    const config: ExperimentConfig = {
      kind: dto.kind ?? AuctionKind.DIRECT,
      clients: dto.clients ?? 30,
      commands: dto.commands ?? 120,
      trials: dto.trials ?? 40,
      networkLatencyMs: dto.networkLatencyMs ?? 120,
      networkJitterMs: dto.networkJitterMs ?? 180,
      disconnectRate: dto.disconnectRate ?? 0.2,
      duplicateRate: dto.duplicateRate ?? 0.12,
      burstWindowMs: dto.burstWindowMs ?? 250,
      seed: dto.seed ?? 506911,
    };
    return runArchitectureExperiment(config);
  }
}
