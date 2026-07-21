import { IsString, Matches } from 'class-validator';

export class PublishAuctionDto {
  @IsString()
  @Matches(/^@?[A-Za-z0-9_]{5,}$/)
  channelUsername: string;
}
