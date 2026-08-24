/**
 * Removes the agent's own speech from what the caller appears to have said.
 *
 * On a speakerphone the agent's voice leaves the caller's handset, comes straight back into its
 * microphone, and is transcribed as if the caller had said it. The result is not noisy audio -
 * it is clean, well-formed speech in the agent's own words - so no ASR setting rejects it and
 * nothing downstream can tell it apart from the caller talking. A real call produced:
 *
 *   "Hi, can you tell me more about the inbox? Night so you when you"
 *
 * where "night so you when you" is a fragment of the agent's own previous sentence ("...follow
 * you home at NIGHT, SO YOU..."). That string reached the classifier and the reply model, which
 * is why the agent then answered half-sentences of its own and the conversation went in circles.
 *
 * Endpoint echo cancellation is the real fix and it is not ours: the same caller on earbuds is
 * clean. This is the part we control.
 *
 * The filter is deliberately timid, because deleting words a caller really said is far worse
 * than leaving an echo in. It only removes a run of MIN_ECHO_TOKENS or more consecutive tokens
 * that appears verbatim in something the agent said moments ago. Short overlaps survive
 * untouched - a caller answering "yes, the inbox" is agreeing, not echoing, and any threshold
 * low enough to catch that would eat ordinary agreement all day.
 */

/**
 * Three, which is as low as this can safely go and no lower.
 *
 * The real echo that prompted all this was "night so you" - three tokens, from "...follow you
 * home at NIGHT, SO YOU get your evenings back". At four it was missed entirely.
 *
 * Three is safe because a caller agreeing with the agent does not reproduce its word ORDER: the
 * agent says "on your own email" and the caller says "my own email", which shares only two
 * consecutive tokens. Agreement paraphrases; echo is verbatim by construction. Two would start
 * catching agreement, so this is the floor.
 */
const MIN_ECHO_TOKENS = 3;

/** How many recent agent utterances to check against. */
const RECENT_UTTERANCES = 3;

/** Punctuation, casing and grouping are noise: ASR and TTS do not agree on any of them. */
function normalise(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tokenise(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

/** Does `needle` appear as a contiguous run inside `haystack`? */
function containsRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Remembers what the agent has said recently, so the caller's transcript can be compared to it.
 *
 * Kept per-conversation and deliberately short: echo arrives within a turn or two of being
 * spoken, and a longer memory only widens the window in which a caller's genuine words can
 * collide with something the agent happened to say earlier.
 */
export class SpeakerEchoFilter {
  private recent: string[][] = [];

  /** Record something the agent spoke aloud - a reply, or the filler in front of it. */
  noteAgentSpeech(text: string): void {
    const tokens = tokenise(text).map(normalise).filter((t) => t.length > 0);
    if (tokens.length === 0) return;
    this.recent.push(tokens);
    if (this.recent.length > RECENT_UTTERANCES) this.recent.shift();
  }

  /**
   * The caller's transcript with any echoed spans removed.
   *
   * Returns the text unchanged when nothing matches, which is the overwhelmingly common case:
   * a caller on a handset or earbuds never trips this at all.
   */
  filter(text: string): string {
    if (this.recent.length === 0) return text;

    const tokens = tokenise(text);
    if (tokens.length < MIN_ECHO_TOKENS) return text;
    // Punctuation-only tokens ("--", "...") normalise to nothing. Left in the comparison they
    // split an echo in half and hide it, so they are dropped from the matching entirely and
    // rejoined afterwards by position.
    const indexed = tokens
      .map((token, index) => ({ token, index, norm: normalise(token) }))
      .filter((t) => t.norm.length > 0);
    const norm = indexed.map((t) => t.norm);

    // Pass one: every span the agent also said, without deciding yet whether to remove it.
    const runs: Array<{ from: number; to: number }> = [];
    let i = 0;
    while (i < indexed.length) {
      // The longest run starting here. Longest rather than shortest: stopping at MIN_ECHO_TOKENS
      // would leave the tail of a long echo behind, which is the half that reads as the caller
      // having said something strange.
      let matched = 0;
      for (let len = indexed.length - i; len >= MIN_ECHO_TOKENS; len--) {
        const candidate = norm.slice(i, i + len);
        if (this.recent.some((utterance) => containsRun(utterance, candidate))) {
          matched = len;
          break;
        }
      }
      if (matched > 0) {
        runs.push({ from: i, to: i + matched });
        i += matched;
      } else {
        i++;
      }
    }

    // Pass two: WHERE the span sits, which is what separates echo from a caller quoting.
    //
    // Echo arrives at the EDGES of a turn. The microphone catches the agent's tail as the caller
    // starts talking, or catches it still going after they stop - so an echoed span has the
    // caller's own words on at most one side of it.
    //
    // A caller repeating the agent does it in the MIDDLE, with their own words either side:
    //
    //   "...and logs what people need instead of losing them to voicemail. That makes sense."
    //
    // Every word of "them to voicemail" came from the agent, and the caller still said all of it
    // - they were summarising back to check they had understood, which is the most ordinary
    // thing a prospect does. An earlier version of this deleted it and left "instead of losing
    // That makes sense", mangling a sentence nobody had a problem with. Flanked spans stay.
    const isMatched = (idx: number) => runs.some((r) => idx >= r.from && idx < r.to);
    const droppedIndices = new Set<number>();
    for (const run of runs) {
      let before = 0;
      for (let k = 0; k < run.from; k++) if (!isMatched(k)) before++;
      let after = 0;
      for (let k = run.to; k < indexed.length; k++) if (!isMatched(k)) after++;
      // At an edge if there is not a sentence's worth of the caller's own words on that side.
      if (before < MIN_ECHO_TOKENS || after < MIN_ECHO_TOKENS) {
        for (let k = run.from; k < run.to; k++) droppedIndices.add(indexed[k].index);
      }
    }

    if (droppedIndices.size === 0) return text;

    // NO attempt is made to tidy up what trails the echo. ASR renders the seam where the
    // microphone caught the agent mid-word as a fragment of its own - "night so you WHEN YOU",
    // whose last two words are in nothing anybody said - and an earlier version of this deleted
    // any short tail after a match to catch them. It also deleted the "how?" off the end of "you
    // said it drafts the reply in your own voice ready to send, how?", which inverts the whole
    // point: a stray "when you" left in front of a model costs nothing, and a deleted "how?"
    // changes what the caller asked. Two orphan function words are noise. A missing question
    // word is a wrong answer.

    const survivors = tokens.filter((_, index) => !droppedIndices.has(index));

    // An utterance that is now nothing but punctuation was entirely echo: the caller said the
    // agent's words and a dash. Returning "--" would hand the classifier a turn that looks like
    // speech, so it becomes properly empty and the runner turns it into silence.
    if (!survivors.some((token) => normalise(token).length > 0)) return '';

    return survivors.join(' ').trim();
  }
}
