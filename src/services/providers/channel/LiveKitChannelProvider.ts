import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

/**
 * Zod schema for LiveKit room channel provider credentials.
 *
 * Used to store the LiveKit server credentials needed to join rooms as a participant and to
 * verify inbound LiveKit webhooks. The same API key and secret sign both the participant access
 * token and the webhook `Authorization` header.
 *
 * This channel is transport-agnostic: a room may be created by a LiveKit SIP gateway carrying a
 * PSTN call, by a browser client, or by any other LiveKit participant. No telephony vendor
 * details belong here.
 */
export const liveKitChannelProviderConfigSchema = z.strictObject({
  url: z.string().describe('LiveKit server URL, e.g. wss://livekit.example.com or ws://127.0.0.1:7880'),
  apiKey: z.string().describe('LiveKit API key used to mint participant access tokens and verify webhooks'),
  apiSecret: z.string().describe('LiveKit API secret paired with apiKey'),
  identity: z.string().optional().describe('Participant identity Bonsai joins rooms under. Defaults to "bonsai-agent".'),
  roomPrefix: z.string().optional().describe('Only join rooms whose name starts with this prefix. Omit to join every room the webhook reports.'),
  apiKeyValue: z.string().describe('Bonsai API key whose project owns these conversations. Rooms have no way to carry credentials, so routing is bound to the provider.'),
  outboundTrunkId: z.string().optional().describe('LiveKit outbound SIP trunk used to dial a second leg into the room. Required only for direct-connect callers; omit to disable outbound entirely.'),
  neverDial: z.array(z.string()).optional().describe('Destinations the channel must refuse to dial, in E.164. Put any number that forwards INTO this channel here: dialing it would loop the call straight back to the agent.'),
  announceTemplate: z.string().optional().describe('Spoken privately to whoever answers a dialed leg, before the two legs are joined. "{caller}" is replaced with the calling party\'s profile name. Omit to bridge silently; the announcement is also skipped when the caller has no name on file.'),
  handoffDecision: z.boolean().optional().describe('Ask whoever answers a dialed leg whether they want the call before joining the two legs. They may answer in speech, or press 1 to accept and 2 to decline. Defaults to false, which joins the legs as soon as the announcement finishes.'),
  handoffRelayStageId: z.string().optional().describe('Stage the conversation moves to when the answering party declines but asked for something to be passed on. Its prompt should speak the relay variable to the caller. Omit to decline silently and carry on screening.'),
  escalateStageId: z.string().optional().describe('Stage whose ENTRY means "put this caller through". When the conversation moves here, the channel dials escalateTo and runs the ordinary announce / accept / decline bridge. Used by a line that screens strangers and escalates the ones worth taking, as opposed to one that bridges known callers on sight.'),
  escalateTo: z.string().optional().describe('Destination dialled when the conversation enters escalateStageId, in E.164. Fixed for the line rather than read from the caller profile, because a stranger has no profile to read.'),
  bridgeFailedStageId: z.string().optional().describe('Stage the conversation moves to when a dialed leg does NOT connect - voicemail, no answer, a silent decline, or a bridge that never resolved. Its prompt should tell the caller they could not be put through and offer to take a message. Omit to leave the caller in silence with the agent, which is what used to happen.'),
  handoffRelayVariable: z.string().optional().describe('Variable on the relay stage the passed-on message is written to. Defaults to "handoffMessage".'),
  demoStageId: z.string().optional().describe('Stage whose ENTRY means "play the recording". When the conversation moves here, the channel plays demoAudioPath into the call and then moves to demoDoneStageId. Entry rather than an effect, for the same reason as escalateStageId: moving stage is something the model can be given an action for, and playing audio is not.'),
  demoAudioPath: z.string().optional().describe('Absolute path to the recording played on entering demoStageId. RAW PCM, mono, signed 16-bit little-endian, at the session sample rate - not MP3 or WAV. Decoding is deliberately not done here: a codec in the media path is a dependency that can fail mid-call, and converting once at deploy time cannot.'),
  demoDoneStageId: z.string().optional().describe('Stage the conversation moves to when the recording finishes or the caller talks over it. Its prompt should pick the conversation back up. Omit and the caller is left in silence after the recording, which is worse than not playing one.'),
  stageId: z.string().optional().describe('Stage to start conversations in. Overridable per room via room metadata.'),
  agentId: z.string().optional().describe('Agent to start conversations with. Overridable per room via room metadata.'),
}).openapi('LiveKitChannelConfig');

/**
 * Optional per-room routing overrides, read from LiveKit room metadata.
 *
 * A SIP dispatch rule (or any other room creator) may attach JSON metadata to route individual
 * rooms to a different stage or agent than the provider default. Unknown keys are ignored so the
 * same metadata blob can carry unrelated fields.
 */
export const liveKitRoomMetadataSchema = z.object({
  stageId: z.string().optional(),
  agentId: z.string().optional(),
}).passthrough();

export type LiveKitRoomMetadata = z.infer<typeof liveKitRoomMetadataSchema>;

export type LiveKitChannelProviderConfig = z.infer<typeof liveKitChannelProviderConfigSchema>;
