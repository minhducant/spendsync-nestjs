import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, UseGuards } from '@nestjs/common';

import { VotePollDto } from '../messages/dto/vote-poll.dto';
import { MessagesService } from '../messages/messages.service';
import { CreateMessageDto } from '../messages/dto/create-message.dto';

/**
 * Events (socket)
 * - client -> server:
 *   - joinRoom { roomId }
 *   - leaveRoom { roomId }
 *   - sendMessage { roomId?, recipients?: string[], ...CreateMessageDto }
 *   - messageDelivered { messageId, userId }
 *   - messageSeen { messageId, userId }
 *   - votePoll { messageId, userId, optionIndex }
 *
 * - server -> client:
 *   - newMessage { message }
 *   - recentMessages { messages }
 *   - messageDelivered { messageId, userId }
 *   - messageSeen { messageId, userId }
 *   - pollUpdated { messageId, pollOptions }
 */

@WebSocketGateway({
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
  },
  // If you need a custom namespace: namespace: '/chat'
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(private readonly messagesService: MessagesService) {}

  afterInit(server: Server) {
    this.logger.log('ChatGateway initialized');
  }

  async handleConnection(socket: Socket) {
    // Optionally: authenticate here using socket.handshake.auth or headers
    const token =
      socket.handshake.auth?.token || socket.handshake.headers?.authorization;
    // TODO: verify token and attach user info to socket.data.userId
    // socket.data.userId = verifiedUserId;

    this.logger.log(
      `Client connected: ${socket.id} user=${socket.data?.userId ?? 'anon'}`,
    );

    // Optionally: send recent messages or rooms the user belongs to
    // Example: send last 50 messages globally
    try {
      const recent = await this.messagesService.findRecent(50);
      socket.emit('recentMessages', recent);
    } catch (err) {
      this.logger.error('Failed to load recent messages on connect', err);
    }
  }

  handleDisconnect(socket: Socket) {
    this.logger.log(
      `Client disconnected: ${socket.id} user=${socket.data?.userId ?? 'anon'}`,
    );
  }

  /**
   * Join a room (chat room or conversation)
   * payload: { roomId: string }
   */
  @SubscribeMessage('joinRoom')
  async handleJoinRoom(
    @MessageBody() payload: { roomId: string },
    @ConnectedSocket() socket: Socket,
  ) {
    const { roomId } = payload || {};
    if (!roomId) return { status: 'error', message: 'roomId required' };
    socket.join(roomId);
    this.logger.log(`Socket ${socket.id} joined room ${roomId}`);
    // Optionally notify others
    socket.to(roomId).emit('userJoined', { socketId: socket.id, roomId });
    return { status: 'ok', roomId };
  }

  /**
   * Leave room
   */
  @SubscribeMessage('leaveRoom')
  async handleLeaveRoom(
    @MessageBody() payload: { roomId: string },
    @ConnectedSocket() socket: Socket,
  ) {
    const { roomId } = payload || {};
    if (!roomId) return { status: 'error', message: 'roomId required' };
    socket.leave(roomId);
    this.logger.log(`Socket ${socket.id} left room ${roomId}`);
    socket.to(roomId).emit('userLeft', { socketId: socket.id, roomId });
    return { status: 'ok', roomId };
  }

  /**
   * Send message: receive payload that follows CreateMessageDto + optional roomId + recipients[]
   * - persist message via MessagesService.create
   * - initialize receipts if recipients provided
   * - broadcast to room if roomId present else broadcast newMessage globally
   */
  @SubscribeMessage('sendMessage')
  async handleSendMessage(
    @MessageBody()
    payload: {
      roomId?: string;
      recipients?: string[]; // userIds
    } & CreateMessageDto,
    @ConnectedSocket() socket: Socket,
  ) {
    try {
      // Extract create DTO portion
      const { roomId, recipients, ...createDto } = payload as any;

      // Save message (attachments handling assumed to be done via REST upload)
      const message = await this.messagesService.create(
        createDto as CreateMessageDto,
        createDto.attachments || [],
      );

      // Initialize receipts for recipients (if given)
      if (Array.isArray(recipients) && recipients.length) {
        await this.messagesService.initReceipts(
          message._id.toString(),
          recipients,
        );
      }

      // Broadcast:
      if (roomId) {
        this.server.to(roomId).emit('newMessage', message);
      } else {
        // fallback: broadcast to everyone
        this.server.emit('newMessage', message);
      }

      return { status: 'ok', id: message._id };
    } catch (err) {
      this.logger.error('sendMessage error', err);
      return { status: 'error', message: 'Failed to send message' };
    }
  }

  /**
   * Mark delivered: client should send { messageId, userId }
   */
  @SubscribeMessage('messageDelivered')
  async handleMessageDelivered(
    @MessageBody() payload: { messageId: string; userId: string },
  ) {
    const { messageId, userId } = payload || {};
    if (!messageId || !userId)
      return { status: 'error', message: 'messageId & userId required' };
    try {
      await this.messagesService.markDelivered(messageId, userId);
      this.server.emit('messageDelivered', { messageId, userId });
      return { status: 'ok' };
    } catch (err) {
      this.logger.error('messageDelivered error', err);
      return { status: 'error' };
    }
  }

  /**
   * Mark seen: client should send { messageId, userId }
   */
  @SubscribeMessage('messageSeen')
  async handleMessageSeen(
    @MessageBody() payload: { messageId: string; userId: string },
  ) {
    const { messageId, userId } = payload || {};
    if (!messageId || !userId)
      return { status: 'error', message: 'messageId & userId required' };
    try {
      await this.messagesService.markSeen(messageId, userId);
      this.server.emit('messageSeen', { messageId, userId });
      return { status: 'ok' };
    } catch (err) {
      this.logger.error('messageSeen error', err);
      return { status: 'error' };
    }
  }

  /**
   * Vote poll: payload { messageId, userId, optionIndex }
   */
  @SubscribeMessage('votePoll')
  async handleVotePoll(
    @MessageBody()
    payload: {
      messageId: string;
      userId: string;
      optionIndex: number;
    },
  ) {
    const { messageId, userId, optionIndex } = payload || {};
    if (!messageId || !userId || typeof optionIndex !== 'number') {
      return {
        status: 'error',
        message: 'messageId, userId, optionIndex required',
      };
    }

    try {
      const updated = await this.messagesService.votePoll(messageId, {
        userId,
        optionIndex,
      } as VotePollDto);

      // Broadcast updated poll options to interested rooms/clients
      this.server.emit('pollUpdated', {
        messageId,
        pollOptions: updated.pollOptions,
      });
      return { status: 'ok' };
    } catch (err) {
      this.logger.error('votePoll error', err);
      return { status: 'error', message: err?.message ?? 'Vote failed' };
    }
  }

  /**
   * Utility: get server health or debug
   */
  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() socket: Socket) {
    socket.emit('pong', { ts: Date.now() });
    return { status: 'ok' };
  }
}
