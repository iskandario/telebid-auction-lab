import { Module } from '@nestjs/common';
import { ExperimentController } from './experiment.controller';
import { ExperimentService } from './experiment.service';

@Module({
  controllers: [ExperimentController],
  providers: [ExperimentService],
})
export class ExperimentModule {}
