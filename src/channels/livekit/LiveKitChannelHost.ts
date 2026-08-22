import { inject, singleton } from 'tsyringe';
import { z } from 'zod';
import express from 'express';
import type { Request, Response } from 'express';
import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { and, eq } from 'drizzle-orm';
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
import type { AudioFrame, RemoteParticipant, RemoteTrack } from '@livekit/rtc-node';
import { AccessToken, WebhookReceiver, SipClient, RoomServiceClient } from 'livekit-server-sdk';
import { db } from '../../db/index';
import { providers, apiKeys, users } from '../../db/schema';
import { SessionManager } from '../SessionManager';
import type { Session } from '../SessionManager';
import { ChannelHandlerDispatcher } from '../ChannelHandlerDispatcher';
import { LiveKitConnection, pcmToAudioFrame } from './LiveKitConnection';
import { LiveKitAnnouncer } from './LiveKitAnnouncer';
import { LiveKitHandoff } from './LiveKitHandoff';
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
 * The whole path runs at 16 kHz. LiveKit decodes Opus to 48 kHz natively and will resample on
 * request, but telephony carries no information above ~4 kHz, so 48 kHz would cost CPU and
 * bandwidth to move upsampled silence. 16 kHz is also what ASR engines are tuned for and is
 * accepted directly by `VadProcessor`, so nothing downstream has to resample either.
 */
const VOICE_SESSION_SETTINGS = sessionSettingsSchema.parse({
  sendVoiceInput: true,
  sendTextInput: false,
  receiveVoiceOutput: true,
  receiveTranscriptionUpdates: false,
  receiveEvents: false,
  sendAudioFormat: 'pcm_16000',
  receiveAudioFormat: 'pcm_16000',
});

/** Sample rate inbound audio is taken at, matching `sendAudioFormat` above. */
const INBOUND_SAMPLE_RATE = 16000;

/** Frame size requested from the inbound audio stream. Matches typical VAD frame granularity. */
const INBOUND_FRAME_SIZE_MS = 20;

/**
 * Voicemail detection thresholds for an answered outbound leg.
 *
 * Carriers answer for voicemail exactly as they answer for a person - 200 OK and media - so the
 * only way to tell them apart is to listen. A person says "hello?" in well under two seconds and
 * then STOPS, waiting. A voicemail greeting is one uninterrupted monologue many seconds long.
 * That difference is large enough that frame energy alone separates them; no model is needed.
 */
const VM_SPEECH_RMS = 500;
/** Continuous speech longer than this is a recording, not a greeting from a person. */
const VM_MONOLOGUE_MS = 6000;
/** A person answering pauses within this long. Used to conclude "this is a human" early. */
const VM_HUMAN_PAUSE_MS = 1500;
/**
 * Give up if nothing is heard at all in this long.
 *
 * This MUST exceed the destination's ring time. The participant joins the room when the call is
 * DIALED, not when it is answered, so the first seconds of the stream are ringing - which is
 * silence. A window shorter than the ring time hangs up on a real person before they can pick up;
 * an early version used ten seconds and abandoned a call at eleven, while the phone was still
 * ringing. US carriers typically ring for 20-25 seconds before voicemail.
 */
const VM_SILENCE_MS = 32000;
/** Hard cap on how long detection may run before deciding. Must exceed VM_SILENCE_MS. */
const VM_DECIDE_BY_MS = 45000;

/**
 * How long the announcement gets to synthesize and play before the legs are joined regardless.
 *
 * Two people are already connected and silent at this point, so a wedged voice must not hold them
 * there. Generous enough that a normal one-line announcement never trips it.
 */
const ANNOUNCE_TIMEOUT_MS = 15000;

/**
 * Identity prefix for a leg this channel dialed out, as opposed to a caller who dialed in.
 *
 * The channel names these participants itself, so matching on the prefix keeps the distinction
 * inside the channel and out of any phone number.
 */
const DIRECT_LEG_PREFIX = 'direct_';

/** Variable the relayed message is written to when the provider does not name one. */
const DEFAULT_RELAY_VARIABLE = 'handoffMessage';

/** Per-room state tracked for cleanup. */
type ActiveCall = {
  room: Room;
  connection: LiveKitConnection;
  sessionId: string;
};

/**
 * A second agent track published for one dialed leg only.
 *
 * Everything in a LiveKit room is heard by everyone subscribed to it, so speaking privately to one
 * participant means publishing somewhere the others are not listening. The caller is unsubscribed
 * from this track before a single frame is written to it.
 */
type WhisperTrack = {
  /** Audio source backing the private track. */
  source: AudioSource;
  /** SID the subscription calls are made against. */
  trackSid: string;
};

/** Everything needed to place a second leg and hold it apart until it is introduced. */
type DirectConnectParams = {
  config: LiveKitChannelProviderConfig;
  projectId: string;
  /** Calling party's identity as the room knows it, used for subscription control. */
  callerIdentity: string;
  /** Calling party's identity as the project knows it, normally their E.164 number. */
  userId: string;
  roomName: string;
  room: Room;
  /** SID of the agent's conversational track, which the dialed leg must not hear while held. */
  agentTrackSid: string | undefined;
  stageId: string | undefined;
  agentId: string | undefined;
};

/** {@link DirectConnectParams} plus the leg that was actually placed. */
type BridgeContext = DirectConnectParams & {
  rooms: RoomServiceClient;
  /** Participant identity of the dialed leg. */
  identity: string;
  /** The private track to announce over, when one could be opened. */
  whisper: WhisperTrack | null;
  /** The rendered line to speak, when the project configured one. */
  announcement: string | null;
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
    @inject(LiveKitAnnouncer) private readonly announcer: LiveKitAnnouncer,
    @inject(LiveKitHandoff) private readonly handoff: LiveKitHandoff,
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
   * No special body parser is needed: the application's global `express.json()` is configured with
   * a `verify` hook that stashes the untouched request buffer on `req.rawBody`, which is what the
   * signature is computed over.
   * @param app - The Express application or router.
   */
  registerRoutes(app: any): void {
    // LiveKit posts with Content-Type: application/webhook+json, which the global express.json()
    // does not match, so its rawBody verify hook never fires and the body is left unparsed. A
    // route-level text parser accepting any content type captures the exact bytes the signature
    // is computed over. The stream is still readable here precisely because the global parser
    // skipped it.
    app.post(
      '/api/livekit/webhook/:channelProviderId',
      express.text({ type: '*/*', limit: '1mb' }),
      asyncHandler(this.handleWebhook.bind(this)),
    );
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

    // The webhook signature covers the RAW request bytes. Re-serialising the parsed body with
    // JSON.stringify produces different bytes (key order, spacing) and the sha256 check fails.
    // The global express.json() parser stashes the original buffer on req.rawBody via its verify
    // hook, so use that; the other branches are only fallbacks for a differently-mounted route.
    const rawBody = this.readRawBody(req);
    const authHeader = req.get('Authorization') ?? '';
    logger.debug({ contentType: req.get('Content-Type'), bodyType: typeof req.body, rawLength: rawBody.length, hasAuth: authHeader.length > 0 }, 'LiveKit webhook: received');

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
   * Bridges a known caller to a second phone leg in the same room, when their profile asks for it.
   *
   * Looks up the caller's user record and reads `profile.transferTo`. When present, dials that
   * number into the same room so caller and destination hear each other. Returns true when a leg
   * was placed.
   *
   * The two legs are NOT joined the moment the second one answers. The answered leg is held apart
   * from the caller while it is classified as a person or a recording and, when a person picked
   * up, while the agent tells them who is calling. Only then are they subscribed to each other.
   * See {@link completeBridge}.
   *
   * Two safeguards, both learned the hard way:
   * - The destination is refused if it appears in the provider's `neverDial` list. Any number that
   *   forwards INTO this channel must be listed there, because dialing it sends the call straight
   *   back to the agent and loops.
   * - The dial carries a timeout. An unattended outbound leg does not hang up by itself; one was
   *   left connected to a voicemail box for two minutes during development.
   *
   * A failure here is never fatal - the caller falls through to normal screening.
   * @param params - Caller, room and routing context for the leg.
   */
  private async tryDirectConnect(params: DirectConnectParams): Promise<boolean> {
    const { config, projectId, userId, roomName, room } = params;
    if (!config.outboundTrunkId) return false;

    try {
      const record = await db.query.users.findFirst({ where: and(eq(users.projectId, projectId), eq(users.id, userId)) });
      const profile = (record?.profile ?? {}) as Record<string, unknown>;
      const destination = typeof profile.transferTo === 'string' ? profile.transferTo.trim() : '';
      if (!destination) return false;

      const refused = (config.neverDial ?? []).map((n) => n.trim());
      if (refused.includes(destination)) {
        logger.warn({ roomName, userId, destination }, 'LiveKit: refusing to dial a number on the neverDial list');
        return false;
      }

      const httpUrl = config.url.replace(/^ws/, 'http');
      const rooms = new RoomServiceClient(httpUrl, config.apiKey, config.apiSecret);
      const identity = `${DIRECT_LEG_PREFIX}${destination}`;

      // Opened before the dial so the private path exists from the moment the leg does. It is a
      // second published track rather than a gap in the main one because "the caller cannot hear
      // this" is then a property of the subscription graph, not of getting the timing right.
      const announcement = this.renderAnnouncement(config.announceTemplate, profile);
      const whisper = announcement ? await this.openWhisper(room, rooms, roomName, params.callerIdentity) : null;

      try {
        const sip = new SipClient(httpUrl, config.apiKey, config.apiSecret);
        await sip.createSipParticipant(config.outboundTrunkId, destination, roomName, {
          participantIdentity: identity,
          participantName: (typeof profile.name === 'string' ? profile.name : 'Direct') + ' line',
          waitUntilAnswered: false,
        });
      } catch (error) {
        await this.closeWhisper(room, whisper);
        throw error;
      }

      logger.info({ roomName, userId, destination, announced: Boolean(whisper) }, 'LiveKit: dialed a direct-connect leg for a known caller');

      void this.completeBridge({ ...params, rooms, identity, whisper, announcement });

      return true;
    } catch (error) {
      logger.error({ error, roomName, userId }, 'LiveKit: direct connect failed, falling back to screening');
      return false;
    }
  }

  /**
   * Holds the dialed leg apart from the caller, decides who answered, announces, then joins them.
   *
   * Runs in the background: the conversation with the caller is already under way, and screening
   * must keep working whatever this concludes. Every exit path ends with the two legs subscribed
   * to each other or the leg removed, so a failure degrades to the unannounced bridge that
   * existed before rather than to two people who cannot hear each other.
   * @param ctx - The dialed leg plus everything needed to speak to it.
   */
  private async completeBridge(ctx: BridgeContext): Promise<void> {
    const { room, rooms, roomName, identity, whisper, announcement, callerIdentity } = ctx;

    // Captured once, before the leg answers: these are the tracks it must not hear yet.
    const held = [...this.trackSidsOf(room, callerIdentity), ...(ctx.agentTrackSid ? [ctx.agentTrackSid] : [])];
    let legTrackSid: string | undefined;
    let frames: AsyncIterator<AudioFrame> | null = null;

    try {
      // Applied straight after the dial rather than on answer. The participant exists from the
      // moment it is dialed and nothing reaches a ringing handset, so this is free to be early.
      await this.setSubscribed(rooms, roomName, identity, held, false);

      const track = await this.waitForTrack(room, identity, VM_DECIDE_BY_MS);
      legTrackSid = track?.sid;

      // ONE reader over the leg, opened here and shared by every phase that listens to it.
      // Voicemail detection and the decision turn are the same listening problem separated by an
      // announcement, and a second AudioStream on this track would receive nothing: cancelling
      // the first detaches the FFI handle for the track itself.
      const stream = track
        ? new AudioStream(track, { sampleRate: INBOUND_SAMPLE_RATE, numChannels: 1, frameSizeMs: INBOUND_FRAME_SIZE_MS })
        : null;
      frames = stream ? stream[Symbol.asyncIterator]() : null;

      // The caller must not hear the far end being classified: a voicemail greeting, or a
      // "hello?" that is about to be answered by an announcement they cannot hear. The leg's
      // track only exists once it answers, so unlike the hold above this cannot be pre-empted and
      // a fraction of the first syllable can reach the caller.
      if (legTrackSid) await this.setSubscribed(rooms, roomName, callerIdentity, [legTrackSid], false);

      if (!track) {
        logger.info({ roomName, identity }, 'LiveKit: no audio from the answered leg, treating as human');
      } else if (frames && await this.classifyAnsweredLeg(frames, identity, roomName)) {
        await rooms.removeParticipant(roomName, identity);
        logger.warn({ roomName, identity }, 'LiveKit: answered leg was voicemail, hung it up and left the caller with the agent');
        return;
      }

      if (whisper && announcement) {
        await this.announceTo(whisper, announcement, ctx);
      }

      // Having been told who is calling, the answering party gets a say in whether the call
      // connects. Only reachable while they are still held apart from the caller, which is why
      // it lives here rather than anywhere further downstream.
      if (ctx.config.handoffDecision && frames) {
        const decision = await this.handoff.ask({ room, frames, identity, roomName, projectId: ctx.projectId, stageId: ctx.stageId });
        logger.info({ roomName, identity, accept: decision.accept, via: decision.via }, 'LiveKit: the answering party decided');

        if (!decision.accept) {
          await rooms.removeParticipant(roomName, identity);
          if (decision.relay) await this.relayToCaller(ctx, decision.relay);
          return;
        }
      }

      await this.joinLegs(rooms, roomName, identity, held, callerIdentity, legTrackSid);
      logger.info({ roomName, identity, announced: Boolean(whisper && announcement) }, 'LiveKit: joined the caller and the answered leg');
    } catch (error) {
      logger.error({ error, roomName, identity }, 'LiveKit: holding the answered leg failed, joining the legs unannounced');
      await this.joinLegs(rooms, roomName, identity, held, callerIdentity, legTrackSid).catch((joinError) => {
        logger.error({ error: joinError, roomName, identity }, 'LiveKit: could not join the legs after a failed hold');
      });
    } finally {
      // Closed exactly once, here, after every phase that listens to the leg is done with it.
      await frames?.return?.().catch(() => undefined);
      await this.closeWhisper(room, whisper);
    }
  }

  /**
   * Passes on what the answering party asked the caller to be told.
   *
   * The words are written to a stage variable and the conversation is moved to the relay stage;
   * the caller then hears the substance from the agent, in the agent's voice, phrased by the
   * project's own prompt. Nothing said on the private leg is piped through to the caller
   * verbatim, and the ordinary guardrails still stand between the two.
   *
   * Silent when no relay stage is configured: the caller simply carries on being screened, which
   * is what happens when the answering party declines without a message.
   * @param ctx - The bridge context, carrying the project's relay configuration.
   * @param relay - What to pass on, in the answering party's own words.
   */
  private async relayToCaller(ctx: BridgeContext, relay: string): Promise<void> {
    const stageId = ctx.config.handoffRelayStageId;
    if (!stageId) {
      logger.info({ roomName: ctx.roomName }, 'LiveKit: no relay stage configured, the declined message was not passed on');
      return;
    }

    const call = this.activeCalls.get(ctx.roomName);
    const session = call ? this.sessionManager.getSession(call.sessionId) : undefined;
    const conversationId = session?.conversationId;
    if (!session || !conversationId) {
      logger.warn({ roomName: ctx.roomName }, 'LiveKit: the caller conversation is gone, the declined message was not passed on');
      return;
    }

    try {
      const context = this.buildContext(session);
      await this.dispatcher.dispatch({
        type: 'set_var',
        conversationId,
        stageId,
        variableName: ctx.config.handoffRelayVariable ?? DEFAULT_RELAY_VARIABLE,
        variableValue: relay,
        correlationId: undefined,
      }, context);
      await this.dispatcher.dispatch({ type: 'go_to_stage', conversationId, stageId, correlationId: undefined }, context);

      logger.info({ roomName: ctx.roomName, stageId }, 'LiveKit: moved the caller to the relay stage');
    } catch (error) {
      logger.error({ error, roomName: ctx.roomName, stageId }, 'LiveKit: failed to pass the declined message to the caller');
    }
  }

  /**
   * Subscribes the caller and the dialed leg to each other, restoring the ordinary room mesh.
   * @param rooms - Room service client for the LiveKit deployment.
   * @param roomName - Room both legs are in.
   * @param identity - Participant identity of the dialed leg.
   * @param held - Track SIDs the leg was held away from, including the agent's own.
   * @param callerIdentity - Participant identity of the calling party.
   * @param legTrackSid - The leg's audio track, once it has published one.
   */
  private async joinLegs(rooms: RoomServiceClient, roomName: string, identity: string, held: string[], callerIdentity: string, legTrackSid: string | undefined): Promise<void> {
    await this.setSubscribed(rooms, roomName, identity, held, true);
    if (legTrackSid) await this.setSubscribed(rooms, roomName, callerIdentity, [legTrackSid], true);
  }

  /**
   * Speaks the announcement into the private track and waits for it to finish playing.
   *
   * Bounded by {@link ANNOUNCE_TIMEOUT_MS}: a slow or wedged voice must not leave two connected
   * people waiting in silence, so the bridge proceeds regardless once the budget is spent.
   * @param whisper - The private track only the answered leg is subscribed to.
   * @param text - The rendered announcement.
   * @param ctx - Routing context, used to find the agent's configured voice.
   */
  private async announceTo(whisper: WhisperTrack, text: string, ctx: BridgeContext): Promise<void> {
    const format = VOICE_SESSION_SETTINGS.receiveAudioFormat;

    const spoken = (async (): Promise<void> => {
      const audio = await this.announcer.synthesize(ctx.projectId, ctx.stageId, ctx.agentId, text, format);
      if (!audio) return;

      const frame = pcmToAudioFrame(audio, pcmSampleRate(format));
      if (!frame) return;

      await whisper.source.captureFrame(frame);
      await whisper.source.waitForPlayout();
    })();

    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        logger.warn({ roomName: ctx.roomName, identity: ctx.identity }, 'LiveKit: the announcement did not finish in time, joining the legs anyway');
        resolve();
      }, ANNOUNCE_TIMEOUT_MS);
    });

    try {
      await Promise.race([spoken, budget]);
    } catch (error) {
      logger.error({ error, roomName: ctx.roomName }, 'LiveKit: the announcement failed, joining the legs unannounced');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Fills in the configured announcement template for this caller.
   *
   * Returns null when there is nothing safe to say - no template configured, or a known caller
   * with no name on file. The channel never invents wording and never learns a caller's details:
   * both come from the project's own records.
   * @param template - The provider's `announceTemplate`, if set.
   * @param profile - The calling party's stored profile.
   */
  private renderAnnouncement(template: string | undefined, profile: Record<string, unknown>): string | null {
    if (!template) return null;

    const name = typeof profile.name === 'string' ? profile.name.trim() : '';
    if (!name) return null;

    return template.replace(/\{caller\}/g, name);
  }

  /**
   * Publishes a second agent track that only the dialed leg will be subscribed to.
   *
   * The caller is unsubscribed from it before anything is ever played, and the track is abandoned
   * if that call fails: a whisper the caller can hear is worse than no whisper at all.
   * @param room - The connected room.
   * @param rooms - Room service client for the LiveKit deployment.
   * @param roomName - Room to publish into.
   * @param callerIdentity - Participant identity of the calling party.
   */
  private async openWhisper(room: Room, rooms: RoomServiceClient, roomName: string, callerIdentity: string): Promise<WhisperTrack | null> {
    const source = new AudioSource(pcmSampleRate(VOICE_SESSION_SETTINGS.receiveAudioFormat), 1);

    try {
      const track = LocalAudioTrack.createAudioTrack('agent-announce', source);
      // Deliberately NOT SOURCE_MICROPHONE. That slot already holds the agent's conversational
      // track, and publishing a second microphone track under the same participant left the
      // first one in a state where captureFrame threw InvalidState - the agent went silent to
      // the caller for the rest of the call while the announcement itself worked fine.
      const publication = await room.localParticipant?.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_UNKNOWN }));
      const trackSid = publication?.sid;
      if (!trackSid) throw new Error('LiveKit returned no SID for the announcement track');

      try {
        await rooms.updateSubscriptions(roomName, callerIdentity, [trackSid], false);
      } catch (error) {
        await room.localParticipant?.unpublishTrack(trackSid, true);
        throw error;
      }

      return { source, trackSid };
    } catch (error) {
      logger.error({ error, roomName }, 'LiveKit: could not open a private announcement track, the bridge will be silent');
      await source.close().catch(() => undefined);
      return null;
    }
  }

  /**
   * Retires the announcement track once the legs are joined or the leg is gone.
   * @param room - The connected room.
   * @param whisper - The track to retire, if one was opened.
   */
  private async closeWhisper(room: Room, whisper: WhisperTrack | null): Promise<void> {
    if (!whisper) return;

    try {
      await room.localParticipant?.unpublishTrack(whisper.trackSid, true);
    } catch (error) {
      logger.warn({ error, trackSid: whisper.trackSid }, 'LiveKit: failed to unpublish the announcement track');
    }

    try {
      await whisper.source.close();
    } catch (error) {
      logger.warn({ error }, 'LiveKit: failed to close the announcement audio source');
    }
  }

  /**
   * Sets an explicit subscription for one participant over a set of tracks.
   *
   * Participants join with autoSubscribe, so this is always an override of that default rather
   * than the first word on the subject.
   * @param rooms - Room service client for the LiveKit deployment.
   * @param roomName - Room the participant is in.
   * @param identity - Participant whose subscriptions are being changed.
   * @param trackSids - Tracks to change. An empty list is a no-op.
   * @param subscribed - Whether the participant should hear them.
   */
  private async setSubscribed(rooms: RoomServiceClient, roomName: string, identity: string, trackSids: string[], subscribed: boolean): Promise<void> {
    if (trackSids.length === 0) return;
    await rooms.updateSubscriptions(roomName, identity, trackSids, subscribed);
  }

  /**
   * Track SIDs a remote participant is currently publishing.
   * @param room - The connected room.
   * @param identity - Participant to read.
   */
  private trackSidsOf(room: Room, identity: string): string[] {
    const participant = room.remoteParticipants.get(identity);
    if (!participant) return [];

    return [...participant.trackPublications.values()]
      .map((publication) => publication.sid)
      .filter((sid): sid is string => Boolean(sid));
  }

  /**
   * Listens to an answered outbound leg and decides whether a person or a recording picked up.
   *
   * Returns true when the leg looks like voicemail. Errs towards "human": a wrong answer that
   * keeps a real person connected is far cheaper than one that hangs up on them.
   * @param track - The answered leg's audio track.
   * @param identity - Participant identity of the outbound leg.
   * @param roomName - For log context.
   */
  private async classifyAnsweredLeg(frames: AsyncIterator<AudioFrame>, identity: string, roomName: string): Promise<boolean> {
    const startedAt = Date.now();
    let speechRunMs = 0;
    let silenceRunMs = 0;
    let heardAnything = false;

    while (true) {
      const next = await frames.next();
      if (next.done) break;
      {
        const frame = next.value;
        const speaking = this.frameRms(frame.data) > VM_SPEECH_RMS;

        if (speaking) {
          heardAnything = true;
          speechRunMs += INBOUND_FRAME_SIZE_MS;
          silenceRunMs = 0;

          // One long unbroken stretch of speech is a recording. People do not do this on answering.
          if (speechRunMs >= VM_MONOLOGUE_MS) {
            logger.info({ roomName, identity, speechRunMs }, 'LiveKit: continuous speech past the monologue threshold, treating as voicemail');
            return true;
          }
        } else {
          silenceRunMs += INBOUND_FRAME_SIZE_MS;

          // A pause after speech is the signature of a person waiting for a reply.
          //
          // The increment has to come FIRST and nothing may reset speechRunMs here. An earlier
          // version tested before incrementing and then zeroed speechRunMs on the very frame
          // where the pause reached its threshold - so by the next frame the `speechRunMs > 0`
          // guard was false and this branch could never fire at all. Detection then ran to its
          // 45-second cap on every call. That was survivable while the bridge connected
          // immediately and only used the verdict to hang up on voicemail; it became fatal the
          // moment the announcement started waiting on it.
          if (heardAnything && speechRunMs > 0 && silenceRunMs >= VM_HUMAN_PAUSE_MS) {
            logger.info({ roomName, identity, speechRunMs }, 'LiveKit: speech then a pause, treating as a person');
            return false;
          }
        }

        if (!heardAnything && Date.now() - startedAt > VM_SILENCE_MS) {
          logger.info({ roomName, identity }, 'LiveKit: nothing heard from the answered leg, treating as voicemail');
          return true;
        }
        if (Date.now() - startedAt > VM_DECIDE_BY_MS) {
          logger.info({ roomName, identity }, 'LiveKit: voicemail detection timed out, defaulting to human');
          return false;
        }
      }
    }

    return false;
  }
  /**
   * Waits for a named participant to publish a subscribed audio track.
   * @param room - The connected room.
   * @param identity - Participant identity to wait for.
   * @param timeoutMs - How long to wait before giving up.
   */
  private async waitForTrack(room: Room, identity: string, timeoutMs: number): Promise<RemoteTrack | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const participant = room.remoteParticipants.get(identity);
      if (participant) {
        for (const publication of participant.trackPublications.values()) {
          if (publication.track) return publication.track as RemoteTrack;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  }

  /**
   * Root-mean-square amplitude of a PCM frame, used as a cheap speech/silence gate.
   * @param samples - Signed 16-bit PCM samples.
   */
  private frameRms(samples: Int16Array): number {
    if (samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  /**
   * Returns the exact bytes of the request body as a string, for signature verification.
   * @param req - The inbound Express request.
   */
  private readRawBody(req: Request): string {
    const raw = (req as Request & { rawBody?: Buffer | string }).rawBody;
    if (Buffer.isBuffer(raw)) return raw.toString('utf8');
    if (typeof raw === 'string') return raw;
    if (typeof req.body === 'string') return req.body;
    return JSON.stringify(req.body);
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

    // Handlers must be attached BEFORE connect. With autoSubscribe the caller's track is often
    // already published by the time we join, so TrackSubscribed can fire during connect().
    // Registering afterwards misses it permanently and the agent never hears anything.
    let inputTurnId: string | null = null;
    // A track can reach us twice: once via TrackSubscribed and once via the post-connect scan for
    // tracks that were already subscribed. Pumping both would feed the runner duplicate audio.
    const pumped = new Set<string>();
    const onTrack = (remoteTrack: RemoteTrack, _publication: unknown, participant: RemoteParticipant): void => {
      logger.info({ roomName, participant: participant.identity, kind: participant.kind }, 'LiveKit: track subscribed');
      if (participant.kind === ParticipantKind.AGENT) return;

      // A dialed leg is not the user. Pumping it into the runner would put whatever the
      // answering party says - including a private "not now, tell her I'll call back" that the
      // caller is deliberately not subscribed to - into the caller's own transcript, and from
      // there into the call summary. The agent listens to this leg through the bridge path
      // instead, which reads the track directly.
      if (participant.identity.startsWith(DIRECT_LEG_PREFIX)) {
        logger.info({ roomName, participant: participant.identity }, 'LiveKit: dialed leg, not routing it into the conversation');
        return;
      }
      const key = remoteTrack.sid ?? `${participant.identity}:${remoteTrack.name}`;
      if (pumped.has(key)) {
        logger.debug({ roomName, key }, 'LiveKit: track already being pumped, ignoring duplicate');
        return;
      }
      pumped.add(key);
      this.pumpInboundAudio(remoteTrack, roomName, () => inputTurnId).catch((error) => {
        logger.error({ error, roomName }, 'LiveKit: inbound audio pump failed');
      });
    };
    room.on(RoomEvent.TrackSubscribed, onTrack);

    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      // A leg WE dialed leaving is not the call ending. Both the voicemail path and a declined
      // handoff remove that participant deliberately, and tearing the room down on it hung up on
      // the caller too - the relay reached a conversation that had been closed 100ms earlier, and
      // "hung up the voicemail leg and left the caller with the agent" had never actually done
      // that. Only the party who dialed IN ending the call ends the call.
      if (participant.identity.startsWith(DIRECT_LEG_PREFIX)) {
        logger.info({ roomName, participant: participant.identity }, 'LiveKit: dialed leg left, the caller is still on the line');
        return;
      }
      this.teardown(roomName).catch((error) => logger.error({ error, roomName }, 'LiveKit: teardown after participant disconnect failed'));
    });

    room.on(RoomEvent.Disconnected, () => {
      this.teardown(roomName).catch((error) => logger.error({ error, roomName }, 'LiveKit: teardown after room disconnect failed'));
    });

    await room.connect(config.url, jwt, { autoSubscribe: true, dynacast: false });

    const outboundSampleRate = pcmSampleRate(VOICE_SESSION_SETTINGS.receiveAudioFormat);
    const audioSource = new AudioSource(outboundSampleRate, 1);
    const track = LocalAudioTrack.createAudioTrack('agent-voice', audioSource);
    const agentPublication = await room.localParticipant?.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));

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

    // A caller the project has marked for direct connection is bridged to a second leg instead of
    // being screened. The destination and the name spoken in the announcement come from that
    // user's profile, never from channel code, so this stays transport-agnostic and no phone
    // number or caller-specific wording is baked in here.
    // The bridge is attempted in the background and the conversation always starts. If the leg
    // turns out to be voicemail, the agent is already talking to the caller and screening
    // continues - rather than the caller being dropped into a recording with no explanation.
    void this.tryDirectConnect({
      config,
      projectId,
      callerIdentity,
      userId,
      roomName,
      room,
      agentTrackSid: agentPublication?.sid,
      stageId,
      agentId,
    });

    logger.info({ sessionId, projectId, roomName, userId, stageId, agentId }, 'LiveKit: new voice session created');

    const startMsg: CALInputMessage = { type: 'start_conversation', userId, stageId, agentId, correlationId: undefined };
    await this.dispatcher.dispatch(startMsg, this.buildContext(session));

    // Deliberately NOT opening a user voice turn here. start_conversation kicks off the
    // greeting, so the runner is in generating_response and would reject it. The turn opens in
    // onAiTurnEnd once the greeting has finished playing out.

    // Catch tracks that were already subscribed before the handlers above were attached, which
    // happens whenever the caller published before we joined.
    for (const participant of room.remoteParticipants.values()) {
      if (participant.kind === ParticipantKind.AGENT) continue;
      for (const publication of participant.trackPublications.values()) {
        const existing = publication.track;
        if (existing) {
          logger.info({ roomName, participant: participant.identity }, 'LiveKit: picking up an already-subscribed track');
          onTrack(existing as RemoteTrack, publication, participant);
        }
      }
    }
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
    logger.info({ roomName }, 'LiveKit: inbound audio pump started');

    let delivered = 0;

    for await (const frame of stream) {
      // Frames can arrive before the session is registered: subscribing happens as soon as we
      // publish, which is the very thing that makes the SIP side answer, and registration happens
      // a few statements later. Skip those early frames rather than exiting - breaking here would
      // end the pump permanently and the agent would never hear the caller.
      const call = this.activeCalls.get(roomName);
      if (!call) continue;
      const session = this.sessionManager.getSession(call.sessionId);
      if (!session?.conversationId || !session.runner) continue;

      const activeInputTurnId = getInputTurnId();
      if (activeInputTurnId === null && !session.runner.isVadMode) continue;

      const buffer = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
      await session.runner.receiveUserVoiceData(activeInputTurnId ?? '', buffer);

      delivered++;
      if (delivered === 1) logger.info({ roomName }, 'LiveKit: first inbound audio frame delivered to the runner');
    }

    logger.info({ roomName, delivered }, 'LiveKit: inbound audio pump ended');
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
