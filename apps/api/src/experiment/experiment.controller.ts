import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ExperimentService } from './experiment.service';
import { RunExperimentDto } from './run-experiment.dto';

@ApiTags('experiments')
@Controller('experiments')
export class ExperimentController {
  constructor(private readonly experiments: ExperimentService) {}

  @Post('run')
  run(@Body() dto: RunExperimentDto) {
    return this.experiments.run(dto);
  }
}
