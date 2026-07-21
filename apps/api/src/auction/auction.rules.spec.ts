import { BadRequestException } from '@nestjs/common';
import { AuctionKind } from '../common/domain.types';
import { assertBidIsBetter, shouldExtendAuction } from './auction.rules';

describe('auction rules', () => {
  it('accepts a direct bid above the minimum step', () => {
    expect(() => assertBidIsBetter(AuctionKind.DIRECT, 1000, 100, 1100)).not.toThrow();
  });

  it('rejects a direct bid below the minimum step', () => {
    expect(() => assertBidIsBetter(AuctionKind.DIRECT, 1000, 100, 1099)).toThrow(BadRequestException);
  });

  it('accepts a reverse offer below the minimum step', () => {
    expect(() => assertBidIsBetter(AuctionKind.REVERSE, 1000, 100, 900)).not.toThrow();
  });

  it('extends only inside the anti-sniping window', () => {
    const now = new Date('2026-07-21T10:00:00.000Z');
    expect(shouldExtendAuction(new Date('2026-07-21T10:00:10.000Z'), now, 15, 30)).toBe(true);
    expect(shouldExtendAuction(new Date('2026-07-21T10:00:20.000Z'), now, 15, 30)).toBe(false);
  });
});
