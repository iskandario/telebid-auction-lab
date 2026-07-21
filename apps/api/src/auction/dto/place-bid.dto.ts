import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator';

export class PlaceBidDto {
  @IsString()
  @MinLength(2)
  @IsOptional()
  participantId?: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsUUID()
  commandId: string;
}
