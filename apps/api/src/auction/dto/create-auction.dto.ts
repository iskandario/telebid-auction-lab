import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { AuctionKind } from '../../common/domain.types';

export class CreateAuctionDto {
  @IsEnum(AuctionKind)
  kind: AuctionKind;

  @IsString()
  @MinLength(3)
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @MinLength(1)
  @IsOptional()
  ownerId?: string;

  @IsString()
  @MinLength(1)
  @IsOptional()
  ownerDisplayName?: string;

  @IsString()
  @MinLength(2)
  @IsOptional()
  category?: string;

  @IsString()
  @MinLength(2)
  @IsOptional()
  placementFormat?: string;

  @IsDateString()
  @IsOptional()
  placementAt?: string;

  @IsString()
  @IsOptional()
  channelUsername?: string;

  @IsString()
  @IsOptional()
  channelTitle?: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  channelSubscribers?: number;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  startingPrice: number;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  minStep: number;

  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(86400)
  durationSeconds: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(300)
  @IsOptional()
  antiSnipingWindowSec?: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(600)
  @IsOptional()
  extensionSec?: number;
}
