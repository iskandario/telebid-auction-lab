import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuctionService } from './auction.service';
import { TelegramAuthService } from '../telegram/telegram-auth.service';
import { CreateAuctionDto } from './dto/create-auction.dto';
import { PlaceBidDto } from './dto/place-bid.dto';

@ApiTags('auctions')
@Controller('auctions')
export class AuctionController {
  constructor(
    private readonly auctions: AuctionService,
    private readonly telegramAuth: TelegramAuthService,
  ) {}

  @Get()
  list() {
    return this.auctions.list();
  }

  @Post()
  create(
    @Body() dto: CreateAuctionDto,
    @Headers('authorization') authorization?: string,
    @Headers('x-demo-user') demoUserId?: string,
    @Headers('x-demo-name') demoDisplayName?: string,
  ) {
    const user = this.telegramAuth.resolve(authorization, demoUserId, demoDisplayName);
    return this.auctions.create({ ...dto, ownerId: user.id, ownerDisplayName: user.displayName });
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.auctions.get(id);
  }

  @Get(':id/bids')
  listBids(@Param('id', ParseUUIDPipe) id: string) {
    return this.auctions.listBids(id);
  }

  @Post(':id/bids')
  placeBid(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PlaceBidDto,
    @Headers('authorization') authorization?: string,
    @Headers('x-demo-user') demoUserId?: string,
    @Headers('x-demo-name') demoDisplayName?: string,
  ) {
    const user = this.telegramAuth.resolve(authorization, demoUserId, demoDisplayName);
    return this.auctions.placeBid(id, { ...dto, participantId: user.id });
  }

  @Post(':id/close')
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('force', new ParseBoolPipe({ optional: true })) force = false,
    @Headers('authorization') authorization?: string,
    @Headers('x-demo-user') demoUserId?: string,
    @Headers('x-demo-name') demoDisplayName?: string,
  ) {
    const user = this.telegramAuth.resolve(authorization, demoUserId, demoDisplayName);
    const auction = await this.auctions.get(id);
    if (auction.ownerId !== user.id) {
      throw new ForbiddenException('Завершить торги может только владелец');
    }
    return this.auctions.close(id, force);
  }
}
