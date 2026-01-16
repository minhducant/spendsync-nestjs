import { Module } from '@nestjs/common';
import { ChatGateway } from './chat.gateway';
import { MessagesModule } from '../messages/messages.module';

/**
 * ChatModule wires ChatGateway and imports MessagesModule to persist messages.
 */
@Module({
  imports: [MessagesModule],
  providers: [ChatGateway],
  exports: [ChatGateway],
})
export class ChatModule {}
