import { singleton } from 'tsyringe';
import { z } from 'zod';
import type { ICommunicationChannel, ChannelCapabilities } from '../IChannelDescriptor';
import type { ApiKeyChannel } from '../../apiKeyFeatures';
import type { AudioFormat } from '../../types/audio';

/**
 * Audio formats supported by the LiveKit room transport.
 *
 * LiveKit delivers and accepts raw PCM through the Node SDK; the wire codec (Opus) is handled
 * inside the SDK. Inbound frames arrive at 48 kHz, which is why `pcm_48000` leads the list.
 */
const LIVEKIT_SUPPORTED_AUDIO_FORMATS: AudioFormat[] = ['pcm_48000', 'pcm_24000', 'pcm_16000', 'pcm_8000'];

/**
 * ICommunicationChannel implementation for the LiveKit room transport.
 *
 * Voice-only channel. Bonsai joins a LiveKit room as a participant, subscribes to the remote
 * participant's audio track for user speech, and publishes its own track for agent speech.
 *
 * The channel is deliberately transport-agnostic. A room may be fed by a LiveKit SIP gateway
 * carrying a PSTN call, by a browser client, or by anything else that joins the room, and this
 * channel behaves identically in every case.
 */
@singleton()
export class LiveKitCommunicationChannel implements ICommunicationChannel {
  /** @inheritdoc */
  getType(): ApiKeyChannel {
    return 'livekit';
  }

  /** @inheritdoc */
  getName(): string {
    return 'LiveKit Room';
  }

  /** @inheritdoc */
  getConfigSchema(): z.ZodObject<any> {
    return z.object({});
  }

  /** @inheritdoc */
  getCapabilities(): ChannelCapabilities {
    return {
      supportsVoiceInput: true,
      supportsTextInput: false,
      supportsVoiceOutput: true,
      supportsTextOutput: false,
      supportsCommands: false,
      supportsEvents: false,
      supportsIncomingConnections: true,
      supportsOutgoingConnections: false,
      supportedAudioFormats: LIVEKIT_SUPPORTED_AUDIO_FORMATS,
    };
  }
}
