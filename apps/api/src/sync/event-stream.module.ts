import { Global, Module } from '@nestjs/common';
import { EventStreamService } from './event-stream.service';

@Global()
@Module({
  providers: [EventStreamService],
  exports: [EventStreamService],
})
export class EventStreamModule {}
