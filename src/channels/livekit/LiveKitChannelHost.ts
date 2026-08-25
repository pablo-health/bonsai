import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
import { LiveKitConnection, pcmToAudioFrame, pcmToAudioFrames } from './LiveKitConnection';
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
 * Jitter buffer for the two sources that carry a live conversation between two people.
 *
 * `AudioSource` defaults to a ONE SECOND queue. That is a reasonable default for speech
 * synthesis, which arrives in bursts and wants somewhere to sit, and a terrible one for a bridge:
 * with a source in each direction it puts up to two seconds into a round trip, and it does not
 * recover. `AudioStream` delivers in bursts, the queue absorbs them, and playout is real time -
 * so once the queue has filled it simply stays that far behind for the rest of the call. Two
 * people in the same room heard each other through their handsets a second and a half late.
 *
 * MEASURED, not chosen: at a 100ms cap both directions sat at 102ms and 83ms - saturated. Input
 * and output are both real time, so any burst that forms a queue makes it PERMANENT; the cap is
 * therefore not a ceiling on jitter, it is the latency. 100ms in each direction was ~185ms of
 * round trip that a caller hears as lag.
 *
 * 40ms is two frames: still room for a frame of jitter, and a fifth of the standing delay. Going
 * further risks underruns when the event loop stalls, which are audible as clicks rather than as
 * delay - a worse trade. Re-measure after changing this; the peak is logged at teardown.
 *
 * The producer is not starved by the smaller queue - `captureFrame` simply applies backpressure
 * sooner, which is correct for a real-time source and harmless for the announcement, since
 * `waitForPlayout` still reports the queue draining.
 */
const BRIDGE_QUEUE_MS = 40;

/**
 * US ringback: 440 Hz + 480 Hz, two seconds on, four seconds off.
 *
 * Played to the caller while a leg is ringing, because the alternative is what they got before -
 * "let me try him for you" and then thirty-two seconds of nothing. Silence on a phone call is
 * indistinguishable from a dropped one, so the caller spends the whole hold wondering whether to
 * hang up and try again.
 *
 * Ringback rather than music on purpose. Music-on-hold says "you are parked in a queue for an
 * unknown time"; ringback says "a phone is ringing right now", which is exactly what is happening
 * and what every call transfer in the world sounds like. It is also generated rather than played
 * from a file, so there is no asset to ship and nothing to license.
 */
const RINGBACK_HZ = [440, 480];
const RINGBACK_ON_MS = 2000;
const RINGBACK_OFF_MS = 4000;
/** Well below the agent's speaking level: this is a background, not an announcement. */
const RINGBACK_AMPLITUDE = 0.18;

/**
 * Publish settings for the two tracks that carry a live conversation between two people.
 *
 * Crossing the streams costs one extra Opus generation. A same-room bridge encodes once
 * (SIP -> room); this decodes that and re-encodes into the second room, so the audio is
 * compressed twice before it reaches a handset. There is no way around it here - rtc-node has no
 * API to forward encoded frames without decoding them, and decoding is the whole point of being
 * in the media path. What CAN be done is make the second generation inaudible.
 *
 * `maxBitrate` at 64 kbps is deliberate overkill. The content arriving from the PSTN is band
 * limited to about 4 kHz by G.711 before it ever reaches us, and Opus is already transparent on
 * that band well below this rate - so the second encode stops being a quality decision. It costs
 * a few tens of kbps on one call, which is nothing next to a person hearing artefacts.
 *
 * `dtx: false` because discontinuous transmission suppresses "silence" it detects, and its
 * detector is working on audio that has ALREADY been through a codec. On re-encoded speech that
 * clips quiet onsets - the start of a word after a pause is exactly what it mistakes for silence.
 * Bandwidth saved by not sending silence is worthless on a two-party bridge.
 *
 * `red: true` sends redundant payloads. Packet loss is far more audible than any generation loss
 * being discussed here, and this is the cheap insurance against it.
 */
const BRIDGE_PUBLISH = { audioEncoding: { maxBitrate: BigInt(64000) }, dtx: false, red: true };

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

/**
 * Prefix for the room a dialed leg is placed in, which is never the caller's room.
 *
 * A call to a second line is a COMPLETELY INDEPENDENT call until the person holding it agrees to
 * speak to the caller. Giving it a room of its own is what makes that true structurally: the
 * caller is not in it, so there is nothing to leak and no subscription override that has to hold.
 * An earlier design dialed into the caller's room and hid the leg with `updateSubscriptions`;
 * measured over five real calls the caller heard the private announcement once.
 *
 * The name is also deliberately outside any provider `roomPrefix`, so the webhook ignores every
 * event about these rooms for free - which used to need an identity filter to stop the agent
 * opening a second conversation and screening the number it had just rung.
 */
const BRIDGE_ROOM_PREFIX = 'bridge_';

/**
 * The identity this agent joins a room under, made unique PER ROOM.
 *
 * Every room previously used the bare configured identity, so two concurrent calls put a
 * participant called `bonsai-agent` in each of two rooms. LiveKit only guarantees identity
 * uniqueness WITHIN a room, so that is legal - but it makes two simultaneous calls
 * indistinguishable by identity anywhere that matters, and it is a live suspect for the
 * two-agents-talking-over-each-other symptom seen on a real call.
 *
 * Both the join and the webhook's skip-my-own-join check derive from here. Changing one without
 * the other would have the agent fail to recognise its own arrival and screen itself.
 * @param configured - The provider's `identity`, if set.
 * @param roomName - Room being joined.
 */
/**
 * Everything the carrier said about a caller, recorded once when they arrive.
 *
 * The SIP gateway puts its metadata on the participant as `sip.*` attributes. Those carry the
 * carrier's call id, which is the ONLY value that appears in both Twilio's records and ours -
 * without it, reconstructing a single call means grepping three systems and matching on
 * timestamps.
 *
 * Two fields deserve naming:
 *
 *   name           Where a caller ID NAME would appear. In North America it never does on an
 *                  inbound trunk: CNAM is looked up by the receiving carrier at delivery time
 *                  and does not travel in the signalling, so the gateway synthesises a display
 *                  name from the number instead. Captured anyway - the field costs nothing, and
 *                  a carrier that starts sending one should show up here rather than be noticed
 *                  a month later.
 *
 *   attestation    STIR/SHAKEN, when the trunk is configured to pass it through. Worth more to a
 *                  screener than a name would be: 'A' means the originating carrier vouches that
 *                  this caller is entitled to the number they are displaying, and a spoofed
 *                  number is most of what a screener exists to catch. It is also free, which
 *                  CNAM is not.
 */
function logCallerMetadata(roomName: string, participant: { identity?: string; name?: string; attributes?: Record<string, string> } | undefined): void {
  if (!participant) return;

  const attributes = participant.attributes ?? {};
  const sip: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith('sip.')) sip[key] = value;
  }

  // A synthesised "Phone +1..." is the absence of a name, not a name. Reporting it as one would
  // make every call look like it carried caller ID.
  const rawName = participant.name ?? '';
  const carrierName = rawName && !rawName.replace(/^Phone\s+/, '').startsWith('+') ? rawName : null;

  logger.info({
    roomName,
    identity: participant.identity,
    carrierName,
    attestation: attributes['sip.attestation'] ?? attributes['sip.verstat'] ?? null,
    sip,
  }, 'LiveKit: inbound caller metadata');
}

function agentIdentityFor(configured: string | undefined, roomName: string): string {
  return `${configured ?? 'bonsai-agent'}--${roomName}`;
}

/** Variable the relayed message is written to when the provider does not name one. */
const DEFAULT_RELAY_VARIABLE = 'handoffMessage';

/**
 * Backstop for a bridge that never resolves at all. NOT the normal way a hold ends.
 *
 * Deliberately longer than {@link VM_DECIDE_BY_MS}, because the two are racing and this one
 * losing is what strands the caller. At 30 seconds it fired FOUR SECONDS before voicemail
 * detection reached a verdict on a real call: the caller was handed back to the agent while the
 * bridge was still running, the leg was then hung up as voicemail, and nothing told them - the
 * agent had been given the room back but had no reason to speak, so a real person sat in silence
 * for over two minutes.
 *
 * The normal end of a hold is the bridge resolving, which now always says something either way.
 * This only covers a bridge wedged so badly it never concludes.
 */
const HOLD_MAX_MS = 60000;

/**
 * Where a call's audio is going, and therefore who is in the conversation.
 *
 * The caller publishes one track throughout; what changes is where the frames off it are sent.
 * Nothing here is implemented by asking the model to behave - a prompt saying "keep it short" is
 * a suggestion the model can talk itself out of, and it demonstrably did, screening a known
 * caller for the whole 20-odd seconds her phone was ringing.
 */
type CallState =
  /** Ordinary screening: the caller's audio reaches the runner and the agent answers. */
  | 'screening'
  /** A dialed leg is ringing. The caller's audio is dropped, so there is nothing to respond to. */
  | 'holding'
  /** Two people are connected. The caller's audio crosses to the leg's room, not to the runner. */
  | 'bridged';

/** Per-room state tracked for cleanup. */
type ActiveCall = {
  room: Room;
  connection: LiveKitConnection;
  sessionId: string;
  /** Where this caller's audio currently goes. See {@link CallState}. */
  state: CallState;
  /** The second leg's room and audio path, while one exists. */
  bridge: BridgeLeg | null;
};

/**
 * A dialed leg, the room of its own it lives in, and the audio path between that room and the
 * caller's.
 *
 * The agent is a participant in BOTH rooms and is the only thing that connects them. Before the
 * call is accepted the two directions are not connected at all, which is the whole point; on
 * accept the agent starts copying frames each way. See {@link LiveKitChannelHost.startCrossing}.
 */
type BridgeLeg = {
  /** The agent's connection to the leg's room. */
  room: Room;
  /** Name of the leg's room. Always starts with {@link BRIDGE_ROOM_PREFIX}. */
  roomName: string;
  /** Participant identity of the dialed leg. */
  identity: string;
  /** Room service client for this deployment, used to hang the leg up. */
  rooms: RoomServiceClient;
  /** The caller's room, which the leg's voice is republished into once the call is accepted. */
  callerRoom: Room;
  /** Name of the caller's room, which is the key everything else is tracked under. */
  callerRoomName: string;
  /** Source published in the LEG's room: the announcement, then the caller's voice. */
  toLeg: AudioSource;
  /** Source published in the CALLER's room once accepted, carrying the leg's voice. */
  toCaller: AudioSource | null;
  /** SID of the `toCaller` publication, so it can be retired. */
  toCallerSid: string | undefined;
  /** Set once the bridge is being torn down. Stops the crossing and makes cleanup idempotent. */
  closed: boolean;
  /**
   * True once the leg has been MOVED into the caller's room and is no longer in its own.
   *
   * Everything that addresses the leg by room has to follow it - hanging it up in the room it has
   * left is a no-op that silently leaves a live PSTN call running.
   */
  moved: boolean;
  /**
   * True once the caller has already been told how the bridge ended.
   *
   * A refusal carrying a message is still a refusal: the leg hangs up without being moved, which
   * is indistinguishable at the room level from voicemail or nobody answering. So the caller was
   * given the relay - "Kurt will call you back in an hour" - and then, a beat later, "I'm sorry,
   * I couldn't reach him just now" about the man who had just answered and replied.
   */
  spokenTo: boolean;
};

/** Everything needed to place a second leg in a room of its own. */
type DirectConnectParams = {
  config: LiveKitChannelProviderConfig;
  projectId: string;
  /**
   * Where to dial, when the line decides it rather than the caller's profile.
   *
   * A known-caller line reads `profile.transferTo` - the destination belongs to the person
   * calling. A line that screens strangers has no profile to read, so the destination belongs to
   * the LINE and is passed in.
   */
  destination?: string;
  /** Calling party's identity as the project knows it, normally their E.164 number. */
  userId: string;
  /** The caller's room, which is the key every call is tracked under. */
  roomName: string;
  room: Room;
  stageId: string | undefined;
  agentId: string | undefined;
};

/** {@link DirectConnectParams} plus the leg that was actually placed. */
type BridgeContext = DirectConnectParams & {
  rooms: RoomServiceClient;
  /** The dialed leg and its room. */
  leg: BridgeLeg;
  /** The rendered line to speak to whoever answers, when the project configured one. */
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

    // A room this channel created to hold a dialed leg. Its name is chosen outside any
    // configured roomPrefix, so the check below normally catches it already - this is the belt to
    // that pair of braces, and it holds for a provider configured with no prefix at all.
    if (roomName.startsWith(BRIDGE_ROOM_PREFIX)) {
      logger.debug({ roomName }, 'LiveKit webhook: a room we opened for a dialed leg, ignoring');
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
          if (identity === agentIdentityFor(config.identity, roomName)) break;

          // Everything the carrier told us about this caller, in one line.
          //
          // Recorded because answering "who called me" otherwise means grepping three systems -
          // Twilio's call log, the SIP gateway's, and our own - and joining them by hand on a
          // call id that only appears in two of them. The attributes carry that id, so this line
          // is the join.
          //
          // It is also where a caller NAME would appear if one were ever delivered. None has
          // been: North American CNAM is looked up by the receiving carrier at delivery and does
          // not travel in the signalling, so the display name is synthesised from the number.
          // Capturing the field anyway costs nothing and means the day a carrier does send one,
          // it is already in the record rather than being noticed a month later.
          logCallerMetadata(roomName, event.participant);

          // A leg WE dialed is not an inbound caller and must never be screened. Dialed legs now
          // land in a bridge room the check above already discarded, so this should be
          // unreachable - it stays because the failure it prevents is the agent opening a second
          // conversation and greeting the number it just rang as though IT were the caller, and
          // that is worth two lines.
          if (identity.startsWith(DIRECT_LEG_PREFIX)) {
            logger.info({ roomName, identity }, 'LiveKit webhook: dialed leg joined, not a caller');
            break;
          }

          if (this.activeCalls.has(roomName)) break;
          await this.joinRoom(config, projectId, roomName, identity, event.room?.metadata ?? '');
          break;
        }
        case 'participant_left': {
          // Same rule as the in-room handler: a dialed leg leaving is not the call ending. Tearing
          // down here also deleted the room from activeCalls, which then let the NEXT dialed-leg
          // join slip past the guard above and start its own session.
          const identity = event.participant?.identity ?? '';
          if (identity.startsWith(DIRECT_LEG_PREFIX)) {
            logger.info({ roomName, identity }, 'LiveKit webhook: dialed leg left, the caller is still on the line');
            break;
          }
          await this.teardown(roomName);
          break;
        }
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
   * Reads a caller's stored profile, or null when they are not someone the project knows.
   * @param projectId - Project owning the caller record.
   * @param userId - Caller identity as the project knows it, normally their E.164 number.
   */
  private async lookupProfile(projectId: string, userId: string): Promise<Record<string, unknown> | null> {
    try {
      const record = await db.query.users.findFirst({ where: and(eq(users.projectId, projectId), eq(users.id, userId)) });
      const profile = (record?.profile ?? null) as Record<string, unknown> | null;
      if (profile && Object.keys(profile).length > 0) return profile;
      return null;
    } catch (error) {
      logger.warn({ error, projectId, userId }, 'LiveKit: could not read the caller profile, treating them as unknown');
      return null;
    }
  }

  /**
   * Bridges a known caller to a second phone leg, when their profile asks for it.
   *
   * Looks up the caller's user record and reads `profile.transferTo`. When present, dials that
   * number into a room of its OWN - never the caller's - and returns true. The two are connected
   * only if and when the person who answers agrees to it, at which point the agent starts copying
   * audio between the two rooms. See {@link completeBridge} and {@link startCrossing}.
   *
   * Until that moment the call to the second line is a completely independent call: the caller
   * cannot hear it ring, cannot hear who answered, cannot hear the announcement naming them, and
   * cannot hear a refusal. None of that rests on getting a subscription override right.
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
    const { config, projectId, userId, roomName } = params;
    if (!config.outboundTrunkId) return false;

    try {
      const record = await db.query.users.findFirst({ where: and(eq(users.projectId, projectId), eq(users.id, userId)) });
      const profile = (record?.profile ?? {}) as Record<string, unknown>;
      const fromProfile = typeof profile.transferTo === 'string' ? profile.transferTo.trim() : '';
      const destination = (params.destination ?? '').trim() || fromProfile;
      if (!destination) return false;

      const refused = (config.neverDial ?? []).map((n) => n.trim());
      if (refused.includes(destination)) {
        logger.warn({ roomName, userId, destination }, 'LiveKit: refusing to dial a number on the neverDial list');
        return false;
      }

      const httpUrl = config.url.replace(/^ws/, 'http');
      const rooms = new RoomServiceClient(httpUrl, config.apiKey, config.apiSecret);
      const identity = `${DIRECT_LEG_PREFIX}${destination}`;
      const announcement = this.renderAnnouncement(config.announceTemplate, profile);

      // The agent joins the leg's room and publishes BEFORE the leg is dialed. A handset that
      // answers into an empty room hears nothing and has nobody listening to it, and the window
      // between dial and answer is the only place that work can be done for free.
      const leg = await this.openBridgeRoom(config, params.room, roomName, identity, rooms);
      if (!leg) return false;

      const call = this.activeCalls.get(roomName);
      if (!call) {
        await this.closeBridge(leg);
        return false;
      }
      call.bridge = leg;

      try {
        const sip = new SipClient(httpUrl, config.apiKey, config.apiSecret);
        await sip.createSipParticipant(config.outboundTrunkId, destination, leg.roomName, {
          participantIdentity: identity,
          participantName: (typeof profile.name === 'string' ? profile.name : 'Direct') + ' line',
          waitUntilAnswered: false,
        });
      } catch (error) {
        await this.dropBridge(roomName);
        throw error;
      }

      // From here the caller is waiting to be put through, not being screened.
      this.setCallState(roomName, 'holding');
      logger.info({ roomName, bridgeRoom: leg.roomName, userId, destination, announced: Boolean(announcement) }, 'LiveKit: dialed a direct-connect leg into a room of its own');

      void this.completeBridge({ ...params, rooms, leg, announcement });

      return true;
    } catch (error) {
      logger.error({ error, roomName, userId }, 'LiveKit: direct connect failed, falling back to screening');
      return false;
    }
  }

  /**
   * Decides who answered the dialed leg, announces to them, asks them, and only then connects.
   *
   * Runs in the background: the conversation with the caller is already under way, and screening
   * must keep working whatever this concludes. Everything here happens in the leg's own room, so
   * every intermediate state is inaudible to the caller by construction.
   *
   * Every exit that is not an accept leaves the caller exactly where they were - talking to the
   * agent, with the leg hung up. There is deliberately no "connect them anyway" fallback: that
   * existed when both parties were already in one room and a failure meant two silent people who
   * could not hear each other, which is not a state that can arise now.
   * @param ctx - The dialed leg plus everything needed to speak to it.
   */
  private async completeBridge(ctx: BridgeContext): Promise<void> {
    const { roomName, leg } = ctx;
    let frames: AsyncIterator<AudioFrame> | null = null;
    let crossed = false;
    /** Set once something has been said to the caller about how this ended. */
    let spoken = false;

    try {
      const track = await this.waitForTrack(leg.room, leg.identity, VM_DECIDE_BY_MS);

      // ONE reader over the leg, opened here and shared by every phase that listens to it:
      // voicemail detection, the decision turn, and finally the crossing itself. A second
      // AudioStream on this track would receive nothing - cancelling the first detaches the FFI
      // handle for the track - so the reader is opened once and handed on.
      const stream = track
        ? new AudioStream(track, { sampleRate: INBOUND_SAMPLE_RATE, numChannels: 1, frameSizeMs: INBOUND_FRAME_SIZE_MS })
        : null;
      frames = stream ? stream[Symbol.asyncIterator]() : null;

      if (!track) {
        logger.info({ roomName, identity: leg.identity }, 'LiveKit: no audio from the answered leg, nothing to connect');
        return;
      }

      if (frames && await this.classifyAnsweredLeg(frames, leg.identity, leg.roomName)) {
        logger.warn({ roomName, identity: leg.identity }, 'LiveKit: answered leg was voicemail, hanging it up and leaving the caller with the agent');
        return;
      }

      if (ctx.announcement) {
        await this.announceTo(leg, ctx.announcement, ctx);
      }

      // Having been told who is calling, the answering party gets a say in whether the call
      // connects. This is the last moment at which declining costs the caller nothing, because it
      // is the last moment before the two rooms are joined.
      if (ctx.config.handoffDecision && frames) {
        const decision = await this.handoff.ask({ room: leg.room, frames, identity: leg.identity, roomName: leg.roomName, projectId: ctx.projectId, stageId: ctx.stageId });
        logger.info({ roomName, identity: leg.identity, accept: decision.accept, via: decision.via }, 'LiveKit: the answering party decided');

        if (!decision.accept) {
          // A refusal WITH a message goes to the relay stage, which speaks it. A refusal without
          // one still has to be said out loud - see the finally below.
          if (decision.relay) {
            spoken = await this.relayToCaller(ctx, decision.relay);
          }
          return;
        }
      }

      if (!frames) {
        logger.warn({ roomName, identity: leg.identity }, 'LiveKit: the answered leg published no audio, there is nothing to cross');
        return;
      }

      // A real participant move is better than copying frames, when the server can do it: the
      // two parties end up in one room and the SFU forwards between them, so the audio is
      // encoded once instead of twice and neither our jitter buffer nor our decode sits in the
      // path. Crossing remains the fallback, and is what runs against a stock LiveKit where
      // MoveParticipant answers "not implemented".
      crossed = await this.moveLegToCaller(ctx);
      if (!crossed) crossed = await this.startCrossing(ctx, frames);
    } catch (error) {
      logger.error({ error, roomName, identity: leg.identity }, 'LiveKit: the bridge failed, leaving the caller with the agent');
    } finally {
      // Whatever happened - crossed, voicemail, refused, thrown - the caller stops waiting.
      if (this.activeCalls.get(roomName)?.state === 'holding') this.setCallState(roomName, 'screening');

      // Once crossed, the reader and the leg's room belong to the crossing and must outlive this
      // function. Every other outcome ends the leg here, which also hangs up the PSTN call.
      if (!crossed) {
        await frames?.return?.().catch(() => undefined);
        await this.dropBridge(roomName);

        // AND SOMEBODY HAS TO SAY SO. Handing the room back to an agent is not the same as
        // telling the caller anything: the agent has the words - "I couldn't reach him, is there
        // a message?" - but nothing to prompt it, so it waits for the caller to speak first. A
        // real caller whose bridge went to voicemail sat in silence for over two minutes before
        // saying "testing" and finally hearing it. Dead air after a ring is worse than never
        // having tried the bridge at all.
        if (!spoken) await this.tellCallerTheyCouldNotBePutThrough(ctx.config, ctx.roomName);
      }
    }
  }

  /**
   * Moves the dialed leg into the caller's room, so the two are simply in a room together.
   *
   * This is what the whole two-room arrangement was waiting for. Up to now the leg has been
   * somewhere the caller is not, which is what makes the announcement and the decision private;
   * once the answering party says yes there is no longer any reason for them to be apart, and
   * being in one room means the SFU forwards their audio directly. No decode, no re-encode, no
   * queue of ours in the middle.
   *
   * Returns false when the server will not do it - a stock LiveKit answers "not implemented" -
   * and the caller falls back to crossing the streams, which works everywhere.
   * @param ctx - The dialed leg plus its routing context.
   */
  private async moveLegToCaller(ctx: BridgeContext): Promise<boolean> {
    const { rooms, roomName, leg } = ctx;

    try {
      // Set BEFORE the call: the move makes the leg leave its own room, and anything watching
      // that room for a departure must not read it as the far end hanging up.
      leg.moved = true;
      await rooms.moveParticipant(leg.roomName, leg.identity, roomName);
    } catch (error) {
      leg.moved = false;
      logger.info({ error, roomName, identity: leg.identity }, 'LiveKit: the server would not move the leg, crossing the streams instead');
      return false;
    }

    // The agent no longer needs to be in the leg's room - the leg is not there any more, and the
    // announcement it was published for has been made.
    try {
      await leg.room.disconnect();
    } catch (error) {
      logger.warn({ error, roomName: leg.roomName }, 'LiveKit: failed to leave the bridge room after moving the leg');
    }

    this.activeCalls.get(roomName)?.connection.setMuted(true);
    this.setCallState(roomName, 'bridged');

    logger.info({ roomName, from: leg.roomName, identity: leg.identity }, 'LiveKit: moved the answering party into the caller room, the SFU carries it from here');
    return true;
  }

  /**
   * Crosses the two rooms' audio, making one conversation out of two independent calls.
   *
   * Reads the leg's track and publishes it into the caller's room; feeds the caller's frames,
   * which the inbound pump is already reading, into the leg's room. That is the entire mechanism.
   * Both rooms run PCM16 at 16 kHz, so a frame is copied, not transcoded.
   *
   * This replaces LiveKit's `moveParticipant`, which would detach a live RTP session from one
   * room and reattach it to another. That is server internals we do not have - self-hosted
   * LiveKit answers "not implemented" and v1.13.5 is already latest - and we never needed to move
   * the participant. We only ever needed to move the sound.
   *
   * Keeping the agent in the middle of both directions is a feature, not a cost of the workaround:
   * it can whisper to one side, mute a side, record the legs separately, or take the call back,
   * none of which is possible once two participants are merely co-present in a room. The price is
   * that the agent is now a single point of failure for the media - acceptable, since it is
   * already essential to every call.
   * @param ctx - The dialed leg plus its routing context.
   * @param frames - The already-open reader over the leg's audio.
   * @returns True when audio is flowing both ways.
   */
  private async startCrossing(ctx: BridgeContext, frames: AsyncIterator<AudioFrame>): Promise<boolean> {
    const { room, roomName, leg } = ctx;

    try {
      const source = new AudioSource(pcmSampleRate(VOICE_SESSION_SETTINGS.receiveAudioFormat), 1, BRIDGE_QUEUE_MS);
      const track = LocalAudioTrack.createAudioTrack('bridge-voice', source);
      // Deliberately NOT SOURCE_MICROPHONE. That slot already holds the agent's conversational
      // track in this room, and publishing a second microphone track under one participant left
      // the first in a state where captureFrame threw InvalidState - the agent went silent to the
      // caller for the rest of the call while the second track worked fine.
      const publication = await room.localParticipant?.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_UNKNOWN, ...BRIDGE_PUBLISH }));
      if (!publication?.sid) throw new Error('LiveKit returned no SID for the bridge track');

      leg.toCaller = source;
      leg.toCallerSid = publication.sid;

      // The room stops being the agent's. It is still a publishing participant - that is what
      // makes taking the call back possible - but nothing it generates plays into a conversation
      // between two people. Given back in `dropBridge`.
      this.activeCalls.get(roomName)?.connection.setMuted(true);

      this.setCallState(roomName, 'bridged');
      void this.pumpLegToCaller(leg, frames);

      logger.info({ roomName, bridgeRoom: leg.roomName, identity: leg.identity }, 'LiveKit: crossed the streams, the caller and the answering party are connected');
      return true;
    } catch (error) {
      logger.error({ error, roomName, identity: leg.identity }, 'LiveKit: could not cross the streams, the caller keeps the agent');
      return false;
    }
  }

  /**
   * Copies the answering party's audio into the caller's room, until either side goes away.
   *
   * The reverse direction is not a loop of its own: the caller's frames are already being read by
   * {@link pumpInboundAudio}, which sends them here instead of to the runner while the call is
   * bridged. One reader per track is the only arrangement that works with `AudioStream`.
   * @param leg - The bridged leg.
   * @param frames - The reader over the leg's audio, now owned by this pump.
   */
  private async pumpLegToCaller(leg: BridgeLeg, frames: AsyncIterator<AudioFrame>): Promise<void> {
    const roomName = leg.callerRoomName;
    let delivered = 0;
    /**
     * How much audio is sitting in each direction's queue, sampled while the call runs.
     *
     * This is the part of the delay we own, measured rather than assumed. The default queue was
     * one second and nobody knew until two people in the same apartment heard each other late;
     * the fix was picked by reading a default, not by reading a number. Peak matters more than
     * mean - a queue that fills once and stays full is exactly the failure mode here, and an
     * average hides it.
     */
    let peakToCallerMs = 0;
    let peakToLegMs = 0;

    try {
      while (!leg.closed) {
        const next = await frames.next();
        if (next.done) break;

        const source = leg.toCaller;
        if (!source) break;

        try {
          await source.captureFrame(next.value);
        } catch (error) {
          if (leg.closed) break;
          logger.warn({ error, roomName }, 'LiveKit: dropped a frame on the way to the caller');
          continue;
        }

        delivered++;
        if (delivered === 1) logger.info({ roomName, identity: leg.identity }, 'LiveKit: the caller is hearing the answering party');

        // Sampled once a second rather than per frame: this is diagnostics on a live call, and
        // the queue cannot change meaningfully inside 20ms.
        if (delivered % 50 === 0) {
          // queuedDuration is already MILLISECONDS. Scaling it looked like a 102-second queue
          // against a 100ms cap, which is the sort of number that should stop you rather than be
          // reported.
          peakToCallerMs = Math.max(peakToCallerMs, Math.round(source.queuedDuration ?? 0));
          peakToLegMs = Math.max(peakToLegMs, Math.round(leg.toLeg.queuedDuration ?? 0));
        }
      }
    } catch (error) {
      logger.error({ error, roomName, identity: leg.identity }, 'LiveKit: the leg-to-caller audio path failed');
    } finally {
      await frames.return?.().catch(() => undefined);
      logger.info({
        roomName, identity: leg.identity, delivered,
        // The delay this bridge added, per direction, at its worst.
        peakQueueToCallerMs: peakToCallerMs,
        peakQueueToLegMs: peakToLegMs,
        queueCapMs: BRIDGE_QUEUE_MS,
      }, 'LiveKit: leg-to-caller audio ended');
    }
  }

  /**
   * Joins a room of its own for a leg about to be dialed, and publishes the agent's voice into it.
   *
   * The room name is random and prefixed so that no webhook, and no `roomPrefix` configuration,
   * can cause this room to be mistaken for an inbound call. The identity the agent joins under is
   * derived per room like every other, so two concurrent bridges are distinguishable.
   * @param config - Validated provider config.
   * @param callerRoom - The caller's connected room, where the leg's voice will be republished.
   * @param callerRoomName - Name of the caller's room.
   * @param identity - Participant identity the leg will be dialed under.
   * @param rooms - Room service client for this deployment.
   */
  private async openBridgeRoom(
    config: LiveKitChannelProviderConfig,
    callerRoom: Room,
    callerRoomName: string,
    identity: string,
    rooms: RoomServiceClient,
  ): Promise<BridgeLeg | null> {
    const roomName = `${BRIDGE_ROOM_PREFIX}${randomUUID()}`;
    const agentIdentity = agentIdentityFor(config.identity, roomName);

    const room = new Room();
    const source = new AudioSource(pcmSampleRate(VOICE_SESSION_SETTINGS.receiveAudioFormat), 1, BRIDGE_QUEUE_MS);
    const leg: BridgeLeg = {
      room, roomName, identity, rooms, callerRoom, callerRoomName,
      toLeg: source, toCaller: null, toCallerSid: undefined, closed: false, moved: false,
      spokenTo: false,
    };

    try {
      // The leg hanging up ends the BRIDGE, not the call. The caller is in a different room and
      // is still on the line; they get the agent back rather than dead air.
      room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
        if (participant.identity !== identity) return;
        // A leg that has been MOVED has left this room on purpose, and is now talking to the
        // caller in theirs. Reading that as a hangup would drop the call at the exact moment it
        // succeeded.
        if (leg.moved) {
          logger.info({ roomName, callerRoomName, identity }, 'LiveKit: the dialed leg left this room because it was moved, not because it hung up');
          return;
        }
        logger.info({ roomName, callerRoomName, identity }, 'LiveKit: the dialed leg hung up, giving the caller the agent back');
        this.dropBridge(callerRoomName).catch((error) => logger.error({ error, callerRoomName }, 'LiveKit: could not close the bridge after the leg left'));
        // A leg that hung up WITHOUT being moved never reached the caller: it was rejected, went
        // to voicemail, or was put down. Handing the agent back is right and saying nothing is
        // not - the caller has been holding a live line and knows only that the ringing stopped.
        // Without this the bridge-failed stage exists, is configured, and is never entered.
        //
        // Unless the caller has ALREADY been told. A refusal carrying a message ends with the
        // leg hanging up too, so this fired on top of the relay and followed "Kurt will call you
        // back in an hour" with "I'm sorry, I couldn't reach him just now".
        if (leg.spokenTo) {
          logger.info({ roomName, callerRoomName, identity }, 'LiveKit: the leg hung up after its message was relayed, so the caller has already been told');
          return;
        }
        this.tellCallerTheyCouldNotBePutThrough(config, callerRoomName).catch((error) =>
          logger.error({ error, callerRoomName }, 'LiveKit: could not tell the caller the leg hung up'));
      });

      const token = new AccessToken(config.apiKey, config.apiSecret, { identity: agentIdentity });
      token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
      await room.connect(config.url, await token.toJwt(), { autoSubscribe: true, dynacast: false });

      const track = LocalAudioTrack.createAudioTrack('agent-voice', source);
      await room.localParticipant?.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE, ...BRIDGE_PUBLISH }));

      return leg;
    } catch (error) {
      logger.error({ error, roomName, callerRoomName }, 'LiveKit: could not open a room for the dialed leg');
      await this.closeBridge(leg);
      return null;
    }
  }

  /**
   * Ends the bridge and gives the caller the agent back. Safe to call more than once.
   * @param roomName - The CALLER's room, which the bridge is tracked under.
   */
  private async dropBridge(roomName: string): Promise<void> {
    const call = this.activeCalls.get(roomName);
    const leg = call?.bridge ?? null;
    if (!leg) return;

    if (call) call.bridge = null;
    await this.closeBridge(leg);

    // The agent gets the room back. Whether it should say anything is the stage's business; what
    // matters here is that a caller whose bridge ended is not left with a participant that has
    // been silenced.
    call?.connection.setMuted(false);
    this.setCallState(roomName, 'screening');
  }

  /**
   * Hangs the leg up, retires both ends of the crossing, and leaves its room.
   *
   * Hanging the participant up explicitly matters: an abandoned leg sits in a room nothing
   * reports on, holding a live PSTN call open until the server's empty-room timeout notices.
   * Every step is best-effort and independent - a failure to unpublish must not skip the
   * disconnect.
   * @param leg - The leg to retire.
   */
  private async closeBridge(leg: BridgeLeg): Promise<void> {
    if (leg.closed) return;
    leg.closed = true;

    // Wherever it actually is. After a move the leg lives in the CALLER's room, and hanging it
    // up in the room it left is a no-op that leaves a live PSTN call running until the server's
    // empty-room timeout notices.
    const legRoom = leg.moved ? leg.callerRoomName : leg.roomName;
    try {
      await leg.rooms.removeParticipant(legRoom, leg.identity);
    } catch (error) {
      logger.debug({ error, roomName: legRoom, identity: leg.identity }, 'LiveKit: the dialed leg was already gone');
    }

    if (leg.toCallerSid) {
      try {
        await leg.callerRoom.localParticipant?.unpublishTrack(leg.toCallerSid, true);
      } catch (error) {
        logger.warn({ error, trackSid: leg.toCallerSid }, 'LiveKit: failed to unpublish the bridge track');
      }
    }

    for (const source of [leg.toLeg, leg.toCaller]) {
      if (!source) continue;
      try {
        await source.close();
      } catch (error) {
        logger.warn({ error, roomName: leg.roomName }, 'LiveKit: failed to close a bridge audio source');
      }
    }

    try {
      await leg.room.disconnect();
    } catch (error) {
      logger.warn({ error, roomName: leg.roomName }, 'LiveKit: failed to leave the bridge room');
    }
  }

  /**
   * Plays ringback to the caller for as long as their call is still holding.
   *
   * Writes into the agent's own track in the caller's room, so it stops being heard the moment
   * anything else is said - and stops entirely as soon as the call leaves the holding state,
   * whether that is an accept, a decline, voicemail or a timeout.
   * @param roomName - The caller's room.
   */
  private async playRingback(roomName: string): Promise<void> {
    const rate = pcmSampleRate(VOICE_SESSION_SETTINGS.receiveAudioFormat);
    const frameSamples = Math.floor((rate * INBOUND_FRAME_SIZE_MS) / 1000);
    const cycleMs = RINGBACK_ON_MS + RINGBACK_OFF_MS;

    let elapsedMs = 0;
    let phase = 0;

    while (this.activeCalls.get(roomName)?.state === 'holding') {
      const call = this.activeCalls.get(roomName);
      const source = call?.connection.outboundSource;
      if (!source) return;

      // Never write over the agent. The dial now waits for the greeting so this should not
      // trigger on the first turn, but the agent can speak again mid-hold - a relay, a
      // reassurance - and the tone must give way to it rather than mix with it.
      if (!call?.connection.canPlayFiller) {
        await new Promise((r) => setTimeout(r, INBOUND_FRAME_SIZE_MS));
        continue;
      }

      const pcm = Buffer.alloc(frameSamples * 2);
      if (elapsedMs % cycleMs < RINGBACK_ON_MS) {
        for (let i = 0; i < frameSamples; i++) {
          const t = (phase + i) / rate;
          let v = 0;
          for (const hz of RINGBACK_HZ) v += Math.sin(2 * Math.PI * hz * t);
          pcm.writeInt16LE(Math.round((v / RINGBACK_HZ.length) * RINGBACK_AMPLITUDE * 32767), i * 2);
        }
      }
      // Silence is a frame of zeroes rather than a gap: stopping the stream entirely would let
      // the far end's comfort noise or the codec's DTX decide what the caller hears instead.
      phase += frameSamples;
      elapsedMs += INBOUND_FRAME_SIZE_MS;

      const frame = pcmToAudioFrame(pcm, rate);
      if (!frame) return;
      try {
        await source.captureFrame(frame);
      } catch {
        return;
      }
    }
  }

  /**
   * Moves a call between states, and arms the release that stops a bridge stranding the caller.
   *
   * The release is scheduled independently of whatever the bridge is doing, so a bridge that
   * never resolves cannot leave the caller in silence: whichever comes first wins. It only ever
   * downgrades a call that is still HOLDING - a call that reached `bridged` is two people talking
   * and must not be interrupted by a timer.
   * @param roomName - Room whose caller is being moved.
   * @param state - The state to move to.
   */
  private setCallState(roomName: string, state: CallState): void {
    const call = this.activeCalls.get(roomName);
    if (!call || call.state === state) return;

    call.state = state;
    logger.info({ roomName, state }, 'LiveKit: call state changed');

    if (state !== 'holding') return;

    // Something for the caller to listen to while the other phone rings.
    void this.playRingback(roomName).catch((error) => {
      logger.debug({ error, roomName }, 'LiveKit: ringback stopped');
    });

    setTimeout(() => {
      const current = this.activeCalls.get(roomName);
      if (current?.state !== 'holding') return;
      logger.warn({ roomName }, 'LiveKit: bridge did not resolve in time, giving the caller the agent back');
      this.setCallState(roomName, 'screening');
    }, HOLD_MAX_MS).unref?.();
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
  private async relayToCaller(ctx: BridgeContext, relay: string): Promise<boolean> {
    const stageId = ctx.config.handoffRelayStageId;
    if (!stageId) {
      logger.info({ roomName: ctx.roomName }, 'LiveKit: no relay stage configured, the declined message was not passed on');
      return false;
    }

    const call = this.activeCalls.get(ctx.roomName);
    const session = call ? this.sessionManager.getSession(call.sessionId) : undefined;
    const conversationId = session?.conversationId;
    if (!session || !conversationId) {
      logger.warn({ roomName: ctx.roomName }, 'LiveKit: the caller conversation is gone, the declined message was not passed on');
      return false;
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

      // Before the leg is dropped, because dropping it is what fires the disconnect handler that
      // would otherwise apologise for failing to reach a man who just answered.
      ctx.leg.spokenTo = true;
      logger.info({ roomName: ctx.roomName, stageId }, 'LiveKit: moved the caller to the relay stage');
      return true;
    } catch (error) {
      logger.error({ error, roomName: ctx.roomName, stageId }, 'LiveKit: failed to pass the declined message to the caller');
      return false;
    }
  }

  /**
   * Tells the caller they could not be put through, instead of leaving them in silence.
   *
   * Moves the conversation to a stage whose `enterBehavior` is `generate_response`, so the agent
   * speaks the moment it arrives rather than waiting to be spoken to. That distinction is the
   * whole point: the screening prompt already contains the right sentence, and the agent will
   * produce it perfectly - but only in reply to something. Nobody replies to a bridge failing.
   *
   * Covers every way a bridge can fail to connect: voicemail answered, nothing answered, the
   * answering party refused without a message, or the whole thing threw.
   * @param ctx - The bridge context, carrying the project's stage configuration.
   */
  private async tellCallerTheyCouldNotBePutThrough(
    config: LiveKitChannelProviderConfig,
    callerRoomName: string,
  ): Promise<void> {
    const stageId = config.bridgeFailedStageId;
    if (!stageId) {
      logger.info({ roomName: callerRoomName }, 'LiveKit: no bridge-failed stage configured, the caller was told nothing');
      return;
    }

    const call = this.activeCalls.get(callerRoomName);
    const session = call ? this.sessionManager.getSession(call.sessionId) : undefined;
    const conversationId = session?.conversationId;
    if (!session || !conversationId) return;

    try {
      await this.dispatcher.dispatch({ type: 'go_to_stage', conversationId, stageId, correlationId: undefined }, this.buildContext(session));
      logger.info({ roomName: callerRoomName, stageId }, 'LiveKit: told the caller they could not be put through');
    } catch (error) {
      logger.error({ error, roomName: callerRoomName, stageId }, 'LiveKit: could not tell the caller the bridge failed');
    }
  }

  /**
   * Plays a recording into the caller's own room, and hands the conversation back afterwards.
   *
   * The model cannot do this. It can only say it is doing it, which on the line this was built
   * for produced an agent describing a demo it had no way to play - and, before the classifier
   * was corrected, a demo request read as "put me through" and rang a phone at the exact moment
   * the caller wanted to be SHOWN something.
   *
   * The file is raw PCM at the session rate. No decoding happens here on purpose: a codec in the
   * media path is a dependency that can fail mid-call, and converting once at deploy time cannot.
   *
   * @param config - Channel configuration carrying the path and the stage to return to.
   * @param roomName - The caller's room, which is where this plays.
   * @param audioSource - The agent's own published track, so the recording arrives the same way
   *                      its speech does and needs no second track or publish.
   */
  /** Roughly a minute of trying to hand the conversation back, at the interval below. */
  private static readonly DEMO_RESUME_ATTEMPTS = 30;
  private static readonly DEMO_RESUME_RETRY_MS = 2000;

  /** Rooms whose caller has started talking while a recording plays. */
  private readonly demoInterrupted = new Set<string>();

  private async playDemoRecording(
    config: LiveKitChannelProviderConfig,
    roomName: string,
    audioSource: AudioSource,
  ): Promise<void> {
    const path = config.demoAudioPath;
    if (!path) {
      logger.warn({ roomName }, 'LiveKit: asked to play the recording but none is configured');
      return;
    }

    const format = VOICE_SESSION_SETTINGS.receiveAudioFormat;
    const rate = pcmSampleRate(format);
    let interrupted = false;

    try {
      const pcm = await readFile(path);
      logger.info({ roomName, path, bytes: pcm.length, seconds: Math.round(pcm.length / 2 / rate) },
        'LiveKit: playing the recording to the caller');

      // Frame by frame rather than in one capture, so the caller can stop it. Anything larger
      // than the queue is rejected outright, and a recording is far longer than any sentence -
      // see pcmToAudioFrames.
      for (const frame of pcmToAudioFrames(pcm, rate)) {
        if (this.demoInterrupted.has(roomName)) {
          logger.info({ roomName }, 'LiveKit: the caller talked over the recording, stopping it');
          break;
        }
        await audioSource.captureFrame(frame);
      }
      if (!this.demoInterrupted.has(roomName)) await audioSource.waitForPlayout();
    } catch (error) {
      // A recording that will not play is a disappointment, not a dropped call: the caller is
      // still on the line and the conversation still has somewhere to go.
      logger.error({ error, roomName, path }, 'LiveKit: could not play the recording');
    } finally {
      interrupted = this.demoInterrupted.has(roomName);
      this.demoInterrupted.delete(roomName);
    }

    const stageId = config.demoDoneStageId;
    if (!stageId) {
      logger.warn({ roomName }, 'LiveKit: no stage to return to after the recording, the caller is now in silence');
      return;
    }
    const call = this.activeCalls.get(roomName);
    const session = call ? this.sessionManager.getSession(call.sessionId) : undefined;
    const conversationId = session?.conversationId;
    if (!session || !conversationId) return;
    logger.info({ roomName, stageId, interrupted },
      'LiveKit: handing the conversation back to the line after the recording');

    // Retried, because of WHEN this runs in the interrupted case. Stopping the recording means
    // the caller is mid-sentence, the runner is in receiving_user_voice, and it refuses outright:
    // "Cannot navigate to stage in current state". One attempt therefore always failed exactly
    // when the caller had just started talking - and leaving them in the stage the recording
    // played in strands them there for the rest of the call, with its narrow prompt and without
    // put_through, so asking for a person afterwards would do nothing at all.
    //
    // Their turn finishes within a few seconds and the state clears. Attempts are cheap and
    // stopping after a minute of them means something else is wrong.
    for (let attempt = 0; attempt < LiveKitChannelHost.DEMO_RESUME_ATTEMPTS; attempt++) {
      try {
        await this.dispatcher.dispatch({ type: 'go_to_stage', conversationId, stageId, correlationId: undefined }, this.buildContext(session));
        return;
      } catch (error) {
        const last = attempt === LiveKitChannelHost.DEMO_RESUME_ATTEMPTS - 1;
        if (last) {
          logger.error({ error, roomName, stageId }, 'LiveKit: could not pick the conversation back up after the recording');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, LiveKitChannelHost.DEMO_RESUME_RETRY_MS));
      }
    }
  }

  /**
   * Tells whoever answered the leg who is calling, and waits for it to finish playing.
   *
   * Spoken over the agent's ordinary track in the LEG's room. Nothing about it is private
   * machinery any more - the caller is not in that room, so the announcement naming them cannot
   * reach them however this is published.
   *
   * Bounded by {@link ANNOUNCE_TIMEOUT_MS}: a slow or wedged voice must not leave someone holding
   * a silent handset, so the decision turn proceeds regardless once the budget is spent.
   * @param leg - The dialed leg, whose room the announcement is spoken into.
   * @param text - The rendered announcement.
   * @param ctx - Routing context, used to find the agent's configured voice.
   */
  private async announceTo(leg: BridgeLeg, text: string, ctx: BridgeContext): Promise<void> {
    const format = VOICE_SESSION_SETTINGS.receiveAudioFormat;

    const spoken = (async (): Promise<void> => {
      const audio = await this.announcer.synthesize(ctx.projectId, ctx.stageId, ctx.agentId, text, format);
      if (!audio) return;

      // Transport-sized frames, for the reason given on pcmToAudioFrames: this is a whole
      // synthesised sentence, which is several seconds of audio, and the bridge leg's queue is
      // deliberately short. Captured as one frame it is rejected outright and the person who
      // picked up hears nothing at all - the announcement being the only thing that tells them
      // who is calling and that they may decline.
      for (const frame of pcmToAudioFrames(audio, pcmSampleRate(format))) {
        await leg.toLeg.captureFrame(frame);
      }
      await leg.toLeg.waitForPlayout();
    })();

    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        logger.warn({ roomName: ctx.roomName, identity: leg.identity }, 'LiveKit: the announcement did not finish in time, carrying on without it');
        resolve();
      }, ANNOUNCE_TIMEOUT_MS);
    });

    try {
      await Promise.race([spoken, budget]);
    } catch (error) {
      logger.error({ error, roomName: ctx.roomName }, 'LiveKit: the announcement failed, carrying on without it');
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
    const agentIdentity = agentIdentityFor(config.identity, roomName);

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
    await room.localParticipant?.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));

    /**
     * Set once the second leg has been attempted, so it is attempted exactly once.
     *
     * The attempt is deferred to the end of the first agent turn rather than made immediately -
     * see below.
     */
    let bridgeAttempted = false;

    const onAiTurnEnd = async (): Promise<void> => {
      const current = this.activeCalls.get(roomName);
      if (!current) return;
      const session = this.sessionManager.getSession(current.sessionId);
      if (!session) return;
      session.runner?.notifyAudioPlaybackEnded();

      // DIAL AFTER THE GREETING, NOT BEFORE IT.
      //
      // Dialling immediately meant the leg started ringing while the agent was still saying
      // "let me try him for you" - so the ringback and the greeting were produced into the same
      // audio source at the same time and played over each other. The caller heard ringing and
      // not the sentence explaining it.
      //
      // Waiting is also simply the right order. The promise should land before the ringing
      // starts, which is what a human transfer sounds like: you are told you are being put
      // through, and then you hear the phone ring. The cost is the length of one greeting.
      // BOTH SHAPES COEXIST ON ONE LINE. Someone the project knows has a transferTo and is put
      // through on sight - they should not have to explain themselves to reach a person they
      // already know. A stranger has no transferTo, so this attempt declines, and the decision
      // moves to the conversation, which escalates them if they earn it.
      //
      // The flag is therefore set by the RESULT, not by having tried: marking the attempt done
      // when nothing was dialled would block the escalation that is the whole point of the line.
      if (!bridgeAttempted) {
        const placed = await this.tryDirectConnect({
          config, projectId, userId, roomName, room, stageId, agentId,
        });
        if (placed) bridgeAttempted = true;
      }

      const newId = await this.dispatchStartUserVoiceInput(session);
      if (newId) inputTurnId = newId;
    };

    /**
     * Watches for the conversation asking to be put through.
     *
     * A stranger has no profile and therefore no `transferTo`, so nothing about the caller can
     * decide this - only the conversation can, once they have said who they are and why they
     * called. It says so by moving to the escalation stage, which is a thing the model can be
     * given an action for; dialling is not.
     */
    const onConversationEvent = (eventType: string, eventData: Record<string, unknown>): void => {
      if (eventType !== 'jump_to_stage') return;
      const escalateStageId = config.escalateStageId;
      if (!escalateStageId || eventData.toStageId !== escalateStageId) return;
      if (bridgeAttempted) return;

      bridgeAttempted = true;
      logger.info({ roomName, escalateStageId }, 'LiveKit: the conversation asked to put this caller through');
      void this.tryDirectConnect({
        config, projectId, userId, roomName, room, stageId, agentId,
        destination: config.escalateTo,
      });
    };

    /** Watches for the conversation asking for the recording to be played. */
    const onDemoRequested = (eventType: string, eventData: Record<string, unknown>): void => {
      if (eventType !== 'jump_to_stage') return;
      const demoStageId = config.demoStageId;
      if (!demoStageId || eventData.toStageId !== demoStageId) return;
      this.demoInterrupted.delete(roomName);
      void this.playDemoRecording(config, roomName, audioSource);
    };

    /**
     * Watches for the conversation finishing, so the call can be hung up rather than left open.
     *
     * The room is NOT closed here. The goodbye is still being spoken at this point - the end is
     * deferred until after response delivery precisely so the caller hears it - and disconnecting
     * now would cut it off mid-word, which is worse than leaving the line open. Marked here, hung
     * up in onAiTurnEnd once the audio has actually played out.
     */
    const onConversationFinished = (eventType: string): void => {
      if (eventType !== 'conversation_end' && eventType !== 'conversation_aborted') return;
      logger.info({ roomName, eventType }, 'LiveKit: the conversation is over, hanging up once the goodbye has played');

      // Waits for the goodbye to drain, exactly as LiveKitConnection's own handler does - the
      // sentence is still in the audio queue when this event arrives, and dropping the leg now
      // would cut it off mid-word, which is a worse ending than none.
      void audioSource.waitForPlayout()
        .then(async () => {
          // REMOVING THE CALLER IS WHAT HANGS UP THE PHONE. The connection's handler calls
          // room.disconnect(), which disconnects the AGENT and nothing else: the caller's SIP
          // participant stays, the room stays alive, and the carrier holds the line. From the
          // caller's side nothing happens at all - they are left listening to silence on a call
          // that has ended everywhere except on their handset. One did, and said goodbye a
          // second time first, into a line where nothing was listening any more.
          const httpUrl = config.url.replace(/^ws/, 'http');
          const rooms = new RoomServiceClient(httpUrl, config.apiKey, config.apiSecret);
          await rooms.removeParticipant(roomName, callerIdentity);
          logger.info({ roomName, callerIdentity }, 'LiveKit: caller disconnected, the call is over');
        })
        .catch((error) => {
          // Commonly just the caller having hung up first, which removes them for us.
          logger.info({ error, roomName, callerIdentity }, 'LiveKit: could not disconnect the caller, they may already be gone');
        });
    };

    const onAnyConversationEvent = (eventType: string, eventData: Record<string, unknown>): void => {
      onConversationEvent(eventType, eventData);
      onDemoRequested(eventType, eventData);
      onConversationFinished(eventType);
    };
    const connection = new LiveKitConnection(
      room, audioSource, this.sessionManager, onAiTurnEnd, onAnyConversationEvent,
      () => { this.demoInterrupted.add(roomName); },
    );
    const sessionId = this.sessionManager.registerSession(connection);
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      logger.error({ sessionId, roomName }, 'LiveKit: session not found after registration');
      await room.disconnect();
      return;
    }
    connection.attachSession(session);
    this.sessionManager.setSessionProjectAndSettings(sessionId, projectId, VOICE_SESSION_SETTINGS, null, null);

    this.activeCalls.set(roomName, { room, connection, sessionId, state: 'screening', bridge: null });

    const { stageId, agentId } = this.resolveRouting(config, roomMetadata);
    const userId = this.toUserId(callerIdentity);

    // A caller the project has marked for direct connection has a second leg placed for them
    // instead of being screened. The destination and the name spoken in the announcement come
    // from that user's profile, never from channel code, so this stays transport-agnostic and no
    // phone number or caller-specific wording is baked in here.
    //
    // The attempt itself is made in `onAiTurnEnd`, once the greeting has finished playing - the
    // caller should hear "let me try him for you" before they hear a phone ringing, not
    // underneath it.
    //
    // The bridge is attempted in the background and the conversation always starts. If the leg
    // turns out to be voicemail, or the person who answers declines, the agent is already talking
    // to the caller and screening continues - rather than the caller being dropped into a
    // recording, or into silence, with no explanation.

    logger.info({ sessionId, projectId, roomName, userId, stageId, agentId }, 'LiveKit: new voice session created');

    // The caller's profile is passed EXPLICITLY rather than left for the runner to find.
    //
    // A known caller was greeted as a stranger on every real call - offered the option of
    // leaving a message for the very person they are closest to - while the channel had already
    // read the same record and dialed the second line off it. The stage prompt asks the model to
    // check the profile; without this the profile it checks is empty, so the model correctly
    // concludes the caller is unknown and screens them.
    //
    // It went unnoticed because the scenario suite passes a tester's userProfile in on this same
    // field, so the eval exercised the populated path while every real call took the empty one.
    // The field deep-merges into the stored record, so sending what we just read back is a no-op.
    const callerProfile = await this.lookupProfile(projectId, userId);

    const startMsg: CALInputMessage = {
      type: 'start_conversation', userId, stageId, agentId, correlationId: undefined,
      ...(callerProfile ? { userProfile: callerProfile } : {}),
    };
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
    /**
     * Frames sent ACROSS to the answering party, counted separately from those delivered to the
     * runner. Without this the caller-to-leg half of the crossing is invisible: the leg-to-caller
     * half logs its first frame and its total, so a one-sided bridge looked exactly like a
     * working one in the logs, and only the far end's own ears could tell the difference.
     */
    let crossed = 0;

    for await (const frame of stream) {
      // Frames can arrive before the session is registered: subscribing happens as soon as we
      // publish, which is the very thing that makes the SIP side answer, and registration happens
      // a few statements later. Skip those early frames rather than exiting - breaking here would
      // end the pump permanently and the agent would never hear the caller.
      const call = this.activeCalls.get(roomName);
      if (!call) continue;

      // The caller-to-leg half of the crossing. Their voice goes to the person they asked for and
      // NOT to the runner: an agent that keeps listening starts answering questions that were
      // never addressed to it, over the top of a real conversation. It is still publishing into
      // this room and can be given the call back at any point - see `dropBridge`.
      if (call.state === 'bridged') {
        // Once the leg has been MOVED there is nothing to pump: the two are in one room and the
        // SFU forwards between them. Copying frames into the bridge room's source would be worse
        // than useless - that room has no listener left in it, and the log line it emits claims
        // an audio path that is not the one carrying the call.
        if (call.bridge?.moved) continue;

        const source = call.bridge?.toLeg;
        if (!source) continue;
        try {
          await source.captureFrame(frame);
        } catch (error) {
          logger.warn({ error, roomName }, 'LiveKit: dropped a frame on the way to the answering party');
          continue;
        }

        crossed++;
        if (crossed === 1) logger.info({ roomName, identity: call.bridge?.identity }, 'LiveKit: the answering party is hearing the caller');
        continue;
      }

      // Dropped, not buffered. Replaying twenty seconds of held speech at the moment the caller
      // is put through would have the agent answer questions nobody is still asking, over the top
      // of the person who just picked up.
      if (call.state === 'holding') continue;

      const session = this.sessionManager.getSession(call.sessionId);
      if (!session?.conversationId || !session.runner) continue;

      const activeInputTurnId = getInputTurnId();
      if (activeInputTurnId === null && !session.runner.isVadMode) continue;

      const buffer = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
      await session.runner.receiveUserVoiceData(activeInputTurnId ?? '', buffer);

      delivered++;
      if (delivered === 1) logger.info({ roomName }, 'LiveKit: first inbound audio frame delivered to the runner');
    }

    logger.info({ roomName, delivered, crossed }, 'LiveKit: inbound audio pump ended');
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

    // The caller hanging up hangs the second leg up too. Nothing else will: that leg sits in a
    // room of its own that no webhook reports on, so an abandoned bridge would hold a live PSTN
    // call open until the server's empty-room timeout noticed.
    if (call.bridge) {
      await this.closeBridge(call.bridge).catch((error) => logger.warn({ error, roomName }, 'LiveKit: failed to close the bridge during teardown'));
    }

    logger.info({ roomName, sessionId: call.sessionId }, 'LiveKit: tearing down session');
    await call.connection.close();
  }
}
