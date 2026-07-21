import { Body, Controller, ForbiddenException, Get, Headers, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuctionService } from '../auction/auction.service';
import { PublishAuctionDto } from './dto/publish-auction.dto';
import { TelegramApiService } from './telegram-api.service';
import { TelegramAuthService } from './telegram-auth.service';
import { TelegramBotService } from './telegram-bot.service';

@ApiTags('telegram')
@Controller('telegram')
export class TelegramController {
  constructor(
    private readonly auth: TelegramAuthService,
    private readonly api: TelegramApiService,
    private readonly bot: TelegramBotService,
    private readonly auctions: AuctionService,
  ) {}

  @Get('session')
  async session(
    @Headers('authorization') authorization?: string,
    @Headers('x-demo-user') demoUserId?: string,
    @Headers('x-demo-name') demoDisplayName?: string,
  ) {
    const user = this.auth.resolve(authorization, demoUserId, demoDisplayName);
    const profile = this.api.isConfigured() ? await this.api.getProfile() : null;
    return {
      user,
      telegramConfigured: Boolean(profile),
      botUsername: profile?.username ?? null,
      miniAppUrl: await this.bot.getMiniAppUrl().catch(() => null),
    };
  }

  @Post('auctions/:id/publish')
  async publish(
    @Param('id', ParseUUIDPipe) auctionId: string,
    @Body() dto: PublishAuctionDto,
    @Headers('authorization') authorization?: string,
    @Headers('x-demo-user') demoUserId?: string,
    @Headers('x-demo-name') demoDisplayName?: string,
  ) {
    const user = this.auth.resolve(authorization, demoUserId, demoDisplayName);
    const auction = await this.auctions.get(auctionId);
    if (auction.ownerId !== user.id) throw new ForbiddenException('Опубликовать лот может только владелец');
    const publication = await this.bot.publishAuction(auction, dto.channelUsername, user.id);
    return this.auctions.markPublished(auctionId, user.id, publication);
  }
}
