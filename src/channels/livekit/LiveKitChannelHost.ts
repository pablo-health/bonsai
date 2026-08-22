import { inject, singleton } from 'tsyringe';
import { z } from 'zod';
import type { Request, Response } from 'express';
import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { eq } from 'drizzle-orm';
import {
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  ParticipantKind,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import type { RemoteParticipant, RemoteTrack } from '@livekit/rtc-node';
import { AccessToken, WebhookReceiver } from 'livekit-server-sdk';
import { db } from '../../db/index';
import { providers, apiKeys } from '../../db/schema';
import { SessionManager } from '../SessionManager';
import type { Session } from '../SessionManager';
import { ChannelHandlerDispatcher } from '../ChannelHandlerDispatcher';
import { LiveKitConnection } from './LiveKitConnection';
import { liveKitChannelProviderConfigSchema, liveKitRoomMetadataSchema } from '../../services/providers/channel/LiveKitChannelProvider';
import type { LiveKitChannelProviderConfig } from '../../services/providers/channel/LiveKitChannelProvider';
import { sessionSettingsSchema } from '../websocket/contracts/auth';
import { SecretRefUtils } from '../../services/secrets/SecretRefUtils';
import { pcmSampleRate } from '../../services/audio/AudioFormatUtils';
import { asyncHandler } from '../../utils/asyncHandler';
import type { CALInputMessage } from '../messages';
import type { ClientMessageHandlerContext } from '../ClientMessageHandlerContext';
import { logger } from '../../utils/logger';

/**
 * Default session settings for a voice-only LiveKit call.
 *
 * Inbound audio is taken at 48 kHz because that is what LiveKit decodes Opus to natively, and
 * `VadProcessor` accepts 48 kHz directly, so no inbound resampling is needed. Outbound TTS is
 * requested at 16 kHz, which every PCM-capable TTS provider supports; LiveKit resamples it up to
 * the wire codec internally.
 */
const VOICE_SESSION_SETTINGS = sessionSettingsSchema.parse({
  sendVoiceInput: true,
  sendTextInput: false,
  receiveVoiceOutput: true,
  receiveTranscriptionUpdates: false,
  receiveEvents: false,
  sendAudioFormat: 'pcm_48000',
  receiveAudioFormat: 'pcm_16000',
});

/** Sample rate LiveKit delivers inbound audio at, matching `sendAudioFormat` above. */
const INBOUND_SAMPLE_RATE = 48000;

/** Frame size requested from the inbound audio stream. Matches typical VAD frame granularity. */
const INBOUND_FRAME_SIZE_MS = 20;

/** Per-room state tracked for cleanup. */
type ActiveCall = {
  room: Room;
  connection: LiveKitConnection;
  sessionId: string;
};

/**
 * Channel host for LiveKit rooms.
 *
 * Exposes one entry point: `POST /api/livekit/webhook/:channelProviderId`. LiveKit posts room
 * lifecycle events there; when a non-agent participant joins a matching room, Bonsai connects to
 * that room as a participant, publishes an audio track for agent speech, and subscribes to the
 * participant's track for user speech.
 *
 * The webhook path carries the channel provider id because a LiveKit deployment has a single
 * webhook URL per provider, and the provider record holds the API key and secret needed both to
 * verify the webhook signature and to mint the participant token.
 *
 * Unlike the WebSocket and WebRTC channels there is no client to authenticate or to send
 * `start_conversation`: a room may be created by a SIP gateway on behalf of a caller who has no
 * software at all. The host therefore drives session bootstrap itself, exactly as the Twilio Voice
 * host does for an inbound call.
 *
 * This channel is transport-agnostic by design. It never learns which carrier, if any, delivered
 * the call.
 */
@singleton()
export class LiveKitChannelHost {
  private readonly activeCalls: Map<string, ActiveCall> = new Map();

  constructor(
    @inject(ChannelHandlerDispatcher) private readonly dispatcher: ChannelHandlerDispatcher,
    @inject(SessionManager) private readonly sessionManager: SessionManager,
    @inject(SecretRefUtils) private readonly secretRefUtils: SecretRefUtils,
  ) {}

  /**
   * Returns OpenAPI route configurations for the LiveKit webhook endpoint.
   */
  static getOpenAPIPaths(): RouteConfig[] {
    return [
      {
        method: 'post',
        path: '/api/livekit/webhook/{channelProviderId}',
        tags: ['LiveKit'],
        summary: 'Receive LiveKit room lifecycle webhooks',
        description:
          'Endpoint for LiveKit server webhooks. Configure this URL in the LiveKit server webhook settings. '
          + 'The request body is a signed JWT-authenticated protobuf/JSON payload; the Authorization header is '
          + 'verified against the API key and secret stored on the referenced channel provider. '
          + 'When a non-agent participant joins a room whose name matches the provider roomPrefix, Bonsai joins '
          + 'the room and starts a conversation.',
        security: [],
        request: {
          params: z.object({ channelProviderId: z.string().describe('Channel provider id holding the LiveKit credentials') }),
        },
        responses: {
          200: { description: 'Event accepted' },
          401: { description: 'Webhook signature verification failed' },
          404: { description: 'Channel provider not found' },
        },
      },
    ];
  }

  /**
   * Registers the LiveKit webhook route on the given Express application.
   *
   * The route needs the raw request body for signature verification, so it is mounted with a text
   * body parser rather than the JSON parser used elsewhere.
   * @param app - The Express application or router.
   */
  registerRoutes(app: any): void {
    app.post('/api/livekit/webhook/:channelProviderId', asyncHandler(this.handleWebhook.bind(this)));
  }

  /**
   * Handles a LiveKit webhook event.
   *
   * Verifies the signature against the referenced provider's credentials, then acts on
   * `participant_joined` (join the room and start a conversation) and `room_finished` /
   * `participant_left` (tear the session down).
   */
  private async handleWebhook(req: Request, res: Response): Promise<void> {
    const rawProviderId = req.params.channelProviderId;
    const channelProviderId = Array.isArray(rawProviderId) ? rawProviderId[0] : rawProviderId;

    const resolved = await this.resolveProvider(channelProviderId);
    if (!resolved) {
      res.status(404).json({ error: 'Channel provider not found' });
      return;
    }
    const { config, projectId } = resolved;

    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const authHeader = req.get('Authorization') ?? '';

    let event;
    try {
      const receiver = new WebhookReceiver(config.apiKey, config.apiSecret);
      event = await receiver.receive(rawBody, authHeader);
    } catch (error) {
      logger.warn({ error, channelProviderId }, 'LiveKit webhook: signature verification failed');
      res.status(401).json({ error: 'Invalid webhook signature' });
      return;
    }

    const roomName = event.room?.name;
    if (!roomName) {
      res.status(200).json({ ok: true });
      return;
    }

    if (config.roomPrefix && !roomName.startsWith(config.roomPrefix)) {
      logger.debug({ roomName, roomPrefix: config.roomPrefix }, 'LiveKit webhook: room does not match prefix, ignoring');
      res.status(200).json({ ok: true });
      return;
    }

    res.status(200).json({ ok: true });

    try {
      switch (event.event) {
        case 'participant_joined': {
          const identity = event.participant?.identity ?? '';
          const agentIdentity = config.identity ?? 'bonsai-agent';
          if (identity === agentIdentity) break;
          if (this.activeCalls.has(roomName)) break;
          await this.joinRoom(config, projectId, roomName, identity, event.room?.metadata ?? '');
          break;
        }
        case 'participant_left':
        case 'room_finished': {
          await this.teardown(roomName);
          break;
        }
        default:
          break;
      }
    } catch (error) {
      logger.error({ error, roomName, event: event.event }, 'LiveKit webhook: failed to handle event');
    }
  }

  /**
   * Loads and validates the LiveKit channel provider config, resolving any secret references.
   * @param channelProviderId - The provider record id from the webhook path.
   */
  private async resolveProvider(channelProviderId: string): Promise<{ config: LiveKitChannelProviderConfig; projectId: string } | null> {
    const providerRecord = await db.query.providers.findFirst({ where: eq(providers.id, channelProviderId) });
    if (!providerRecord || providerRecord.providerType !== 'channel') {
      logger.warn({ channelProviderId }, 'LiveKit webhook: channel provider not found or wrong type');
      return null;
    }

    const rawConfig = await this.secretRefUtils.resolveObject(providerRecord.config as Record<string, unknown>);
    const configResult = liveKitChannelProviderConfigSchema.safeParse(rawConfig);
    if (!configResult.success) {
      logger.error({ channelProviderId, issues: configResult.error.issues }, 'LiveKit webhook: channel provider config is invalid');
      return null;
    }

    const apiKeyRecord = await db.query.apiKeys.findFirst({ where: eq(apiKeys.key, configResult.data.apiKeyValue) });
    if (!apiKeyRecord || !apiKeyRecord.isActive) {
      logger.warn({ channelProviderId }, 'LiveKit webhook: configured Bonsai API key is invalid or inactive');
      return null;
    }

    if (apiKeyRecord.keySettings?.allowedChannels && !apiKeyRecord.keySettings.allowedChannels.includes('livekit')) {
      logger.warn({ projectId: apiKeyRecord.projectId }, 'LiveKit webhook: API key does not permit livekit channel');
      return null;
    }

    return { config: configResult.data, projectId: apiKeyRecord.projectId };
  }

  /**
   * Connects to a LiveKit room as a participant, publishes the agent audio track, registers a
   * session, and starts a conversation on behalf of the remote participant.
   * @param config - Validated provider config.
   * @param projectId - Project owning the conversation.
   * @param roomName - Room to join.
   * @param callerIdentity - Identity of the participant that triggered the join.
   * @param roomMetadata - Raw room metadata, optionally carrying stage/agent overrides.
   */
  private async joinRoom(config: LiveKitChannelProviderConfig, projectId: string, roomName: string, callerIdentity: string, roomMetadata: string): Promise<void> {
    const agentIdentity = config.identity ?? 'bonsai-agent';

    const token = new AccessToken(config.apiKey, config.apiSecret, { identity: agentIdentity });
    token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
    const jwt = await token.toJwt();

    const room = new Room();
    await room.connect(config.url, jwt, { autoSubscribe: true, dynacast: false });

    const outboundSampleRate = pcmSampleRate(VOICE_SESSION_SETTINGS.receiveAudioFormat);
    const audioSource = new AudioSource(outboundSampleRate, 1);
    const track = LocalAudioTrack.createAudioTrack('agent-voice', audioSource);
    await room.localParticipant?.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));

    let inputTurnId: string | null = null;

    const onAiTurnEnd = async (): Promise<void> => {
      const current = this.activeCalls.get(roomName);
      if (!current) return;
      const session = this.sessionManager.getSession(current.sessionId);
      if (!session) return;
      session.runner?.notifyAudioPlaybackEnded();
      const newId = await this.dispatchStartUserVoiceInput(session);
      if (newId) inputTurnId = newId;
    };

    const connection = new LiveKitConnection(room, audioSource, this.sessionManager, onAiTurnEnd);
    const sessionId = this.sessionManager.registerSession(connection);
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      logger.error({ sessionId, roomName }, 'LiveKit: session not found after registration');
      await room.disconnect();
      return;
    }
    connection.attachSession(session);
    this.sessionManager.setSessionProjectAndSettings(sessionId, projectId, VOICE_SESSION_SETTINGS, null, null);

    this.activeCalls.set(roomName, { room, connection, sessionId });

    const { stageId, agentId } = this.resolveRouting(config, roomMetadata);
    const userId = this.toUserId(callerIdentity);

    logger.info({ sessionId, projectId, roomName, userId, stageId, agentId }, 'LiveKit: new voice session created');

    const startMsg: CALInputMessage = { type: 'start_conversation', userId, stageId, agentId, correlationId: undefined };
    await this.dispatcher.dispatch(startMsg, this.buildContext(session));

    inputTurnId = await this.dispatchStartUserVoiceInput(session);

    room.on(RoomEvent.TrackSubscribed, (remoteTrack: RemoteTrack, _publication, participant: RemoteParticipant) => {
      if (participant.kind === ParticipantKind.AGENT) return;
      this.pumpInboundAudio(remoteTrack, roomName, () => inputTurnId).catch((error) => {
        logger.error({ error, roomName }, 'LiveKit: inbound audio pump failed');
      });
    });

    room.on(RoomEvent.ParticipantDisconnected, () => {
      this.teardown(roomName).catch((error) => logger.error({ error, roomName }, 'LiveKit: teardown after participant disconnect failed'));
    });

    room.on(RoomEvent.Disconnected, () => {
      this.teardown(roomName).catch((error) => logger.error({ error, roomName }, 'LiveKit: teardown after room disconnect failed'));
    });
  }

  /**
   * Reads inbound audio frames from a subscribed remote track and forwards them to the
   * conversation runner.
   *
   * In VAD mode the runner owns the turn lifecycle and must receive audio continuously, so frames
   * are forwarded with an empty turn id. In non-VAD mode the current input turn id is used.
   * @param remoteTrack - The subscribed remote audio track.
   * @param roomName - Room the track belongs to, used to look the session up.
   * @param getInputTurnId - Accessor for the current input turn id.
   */
  private async pumpInboundAudio(remoteTrack: RemoteTrack, roomName: string, getInputTurnId: () => string | null): Promise<void> {
    const stream = new AudioStream(remoteTrack, { sampleRate: INBOUND_SAMPLE_RATE, numChannels: 1, frameSizeMs: INBOUND_FRAME_SIZE_MS });

    for await (const frame of stream) {
      const call = this.activeCalls.get(roomName);
      if (!call) break;
      const session = this.sessionManager.getSession(call.sessionId);
      if (!session?.conversationId || !session.runner) continue;

      const activeInputTurnId = getInputTurnId();
      if (activeInputTurnId === null && !session.runner.isVadMode) continue;

      const buffer = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
      await session.runner.receiveUserVoiceData(activeInputTurnId ?? '', buffer);
    }
  }

  /**
   * Dispatches a `start_user_voice_input` CAL message and captures the resulting `inputTurnId`.
   * @param session - The session to start the voice input turn for.
   * @returns The new input turn id, or null if the dispatch failed.
   */
  private async dispatchStartUserVoiceInput(session: Session): Promise<string | null> {
    if (!session.conversationId) {
      logger.warn({ sessionId: session.id }, 'LiveKit: cannot start voice input turn — no active conversation');
      return null;
    }

    let capturedInputTurnId: string | null = null;
    const context: ClientMessageHandlerContext = {
      session,
      send: (msg) => {
        if (msg.type === 'start_user_voice_input' && msg.success && msg.inputTurnId) {
          capturedInputTurnId = msg.inputTurnId;
        }
      },
      sendError: (error: string) => { logger.warn({ sessionId: session.id, error }, 'LiveKit: start_user_voice_input error'); },
    };

    await this.dispatcher.dispatch({ type: 'start_user_voice_input', conversationId: session.conversationId, correlationId: undefined }, context);
    return capturedInputTurnId;
  }

  /**
   * Resolves the stage and agent for a room, letting room metadata override provider defaults.
   * @param config - Validated provider config.
   * @param roomMetadata - Raw room metadata string, possibly empty or non-JSON.
   */
  private resolveRouting(config: LiveKitChannelProviderConfig, roomMetadata: string): { stageId: string | undefined; agentId: string | undefined } {
    if (!roomMetadata) return { stageId: config.stageId, agentId: config.agentId };

    try {
      const parsed = liveKitRoomMetadataSchema.safeParse(JSON.parse(roomMetadata));
      if (!parsed.success) return { stageId: config.stageId, agentId: config.agentId };
      return {
        stageId: parsed.data.stageId ?? config.stageId,
        agentId: parsed.data.agentId ?? config.agentId,
      };
    } catch {
      return { stageId: config.stageId, agentId: config.agentId };
    }
  }

  /**
   * Derives the conversation user id from a LiveKit participant identity.
   *
   * A SIP gateway names participants `sip_<e164>`; stripping the prefix yields the caller's phone
   * number, which is what a stage sees as the user id and can key personalisation on. Any other
   * identity is passed through unchanged.
   * @param identity - The remote participant identity.
   */
  private toUserId(identity: string): string {
    return identity.startsWith('sip_') ? identity.slice('sip_'.length) : identity;
  }

  /**
   * Builds a minimal {@link ClientMessageHandlerContext} for general dispatches.
   * @param session - The session to build context for.
   */
  private buildContext(session: Session): ClientMessageHandlerContext {
    return {
      session,
      send: () => { /* responses flow through LiveKitConnection.sendMessage */ },
      sendError: (error: string) => { logger.warn({ sessionId: session?.id, error }, 'LiveKit dispatcher error'); },
    };
  }

  /**
   * Closes the connection for a room and forgets it. Safe to call more than once.
   * @param roomName - The room to tear down.
   */
  private async teardown(roomName: string): Promise<void> {
    const call = this.activeCalls.get(roomName);
    if (!call) return;
    this.activeCalls.delete(roomName);

    logger.info({ roomName, sessionId: call.sessionId }, 'LiveKit: tearing down session');
    await call.connection.close();
  }
}
