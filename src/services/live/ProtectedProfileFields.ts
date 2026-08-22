import { logger } from '../../utils/logger';

/**
 * User-profile fields no conversation may ever write, whatever it is asked to do.
 *
 * `transferTo` is the one that matters. It is what decides whether an inbound call gets dialled
 * out to a real phone, and it is read from the CALLER'S OWN record - so a caller who could get it
 * set on themselves would have talked their way into a bridge to the operator's actual handset.
 * That is a privilege escalation into the person the screener exists to protect, and the whole
 * product promise is that a screened call cannot reach them.
 *
 * Today no stage defines a `modify_user_profile` action, so nothing exercises this path. That is
 * a convention, not a control: the next stage someone adds could open it by accident, and the
 * failure would be silent, delayed by a call, and very hard to attribute. The point of enforcing
 * it here is that the guarantee survives people adding stages later without reading this comment.
 *
 * Enforced at the write, not at the read, because there is exactly one write path and any number
 * of readers.
 */
const PROTECTED = new Set([
  // Governs whether a caller is bridged, and to what number.
  'transferto',
  // Governs whether a caller is treated as known at all, which is what gates the bridge.
  'known',
]);

/**
 * True when a conversation is forbidden from writing this profile field.
 *
 * Case- and separator-insensitive: the field name reaches here from authored action config, and
 * `transfer_to` must not be a way around `transferTo`.
 * @param fieldName - The profile field an effect is trying to modify.
 */
export function isProtectedProfileField(fieldName: string): boolean {
  return PROTECTED.has(fieldName.toLowerCase().replace(/[^a-z]/g, ''));
}

/**
 * Logs and reports a refused write. Loud on purpose: reaching this means either a misconfigured
 * action or a caller who talked the agent into trying, and both are worth seeing.
 * @param fieldName - The field that was refused.
 * @param conversationId - Conversation that attempted it.
 */
export function refuseProtectedWrite(fieldName: string, conversationId: string | undefined): void {
  logger.error(
    { conversationId, fieldName },
    'Refused a conversation attempt to write a protected user-profile field',
  );
}
