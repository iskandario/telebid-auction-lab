import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { AuctionKind } from '../common/domain.types';

export class RunExperimentDto {
  @IsEnum(AuctionKind)
  kind: AuctionKind = AuctionKind.DIRECT;

  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(300)
  clients = 30;

  @Type(() => Number)
  @IsInt()
  @Min(20)
  @Max(1000)
  commands = 120;

  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(200)
  trials = 40;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2000)
  networkLatencyMs = 120;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2000)
  networkJitterMs = 180;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(0.9)
  disconnectRate = 0.2;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(0.9)
  duplicateRate = 0.12;

  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(10000)
  burstWindowMs = 250;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  @IsOptional()
  seed?: number;
}
