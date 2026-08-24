/**
 * The cases this filter has to get right, taken from a real call rather than imagined.
 *
 * Run: npx tsx src/services/live/SpeakerEchoFilter.selftest.ts
 *
 * The dangerous direction is over-deletion. A missed echo makes one turn confusing; a deleted
 * sentence makes the caller repeat themselves to a machine that appears not to be listening,
 * which is the single worst thing a phone line can do. So most of these check that ordinary
 * speech survives untouched.
 */
import { SpeakerEchoFilter } from './SpeakerEchoFilter';

let failures = 0;

function check(name: string, agentSaid: string[], heard: string, expected: string): void {
  const f = new SpeakerEchoFilter();
  agentSaid.forEach((t) => f.noteAgentSpeech(t));
  const got = f.filter(heard);
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) {
    console.log(`       heard    ${JSON.stringify(heard)}`);
    console.log(`       expected ${JSON.stringify(expected)}`);
    console.log(`       got      ${JSON.stringify(got)}`);
  }
}

// The call that prompted this. The tail is the agent's own sentence coming back off a speakerphone.
const REAL_REPLY =
  "So Pablo listens to your sessions and drafts the progress notes for you - that's the main " +
  "thing it does. It takes on all that admin work that tends to follow you home at night, so " +
  "you get your evenings back.";

// The caller's question comes back intact and the echoed clause is gone. "when you" survives:
// it is the ASR's rendering of the seam and appears in nothing the agent said, so nothing can
// match it - and leaving two function words in front of a model is the cheap direction to err.
check('the observed echo is removed, and the real question survives whole',
  [REAL_REPLY],
  'Hi, can you tell me more about the inbox? Night so you when you',
  'Hi, can you tell me more about the inbox? when you');

check('a turn that is nothing but echo comes back empty',
  [REAL_REPLY],
  'that tends to follow you home at night',
  '');

// --- the far more important direction: leaving real speech alone -----------------------------

check('an untouched question survives',
  [REAL_REPLY],
  'Can you tell me what it costs?',
  'Can you tell me what it costs?');

check('short agreement is not an echo',
  ['Is that the piece you wanted to know more about?'],
  'Yes, that piece',
  'Yes, that piece');

check('a caller repeating three words of the agent keeps them',
  ['We can set that up on your own email this week.'],
  'my own email, yes',
  'my own email, yes');

check('nothing said yet, nothing filtered',
  [],
  'Hello, I saw your website',
  'Hello, I saw your website');

// Deliberate quoting is indistinguishable from echo and gets stripped - the accepted cost. What
// must NOT happen is losing the question hanging off the end of it.
check('quoting the agent back loses the quote but never the question',
  ['It drafts the reply in your own voice ready to send.'],
  'You said it drafts the reply in your own voice ready to send, how?',
  'You said how?');

// From a live call, and the reason this filter checks WHERE a span sits. The caller is
// summarising the product back to check they understood it - the most ordinary thing a prospect
// does - and every word of "them to voicemail" is the agent's. An earlier version deleted it and
// left "instead of losing That makes sense", which mangles a sentence nobody had trouble with.
check('a caller summarising the product back keeps every word of it',
  ['It answers calls and logs what people need instead of losing them to voicemail.'],
  "OK. So the phone piece answers calls and logs what people need instead of losing them to " +
  "voicemail. That makes sense. What's the cost?",
  "OK. So the phone piece answers calls and logs what people need instead of losing them to " +
  "voicemail. That makes sense. What's the cost?");

// The same words, at the end of the turn with nothing of the caller's after them: that is the
// microphone still listening when the caller has stopped, and it goes.
check('the same phrase trailing off the end of a turn is echo',
  ['It answers calls and logs what people need instead of losing them to voicemail.'],
  "That makes sense. What's the cost? losing them to voicemail",
  "That makes sense. What's the cost?");

check('only the last few utterances are remembered',
  ['one two three four five', 'a b c d e', 'p q r s t', 'z y x w v'],
  'one two three four five',
  'one two three four five');

check('punctuation and casing do not hide an echo',
  ['follow you home at night'],
  'FOLLOW, YOU HOME -- AT NIGHT!',
  '');

console.log(failures === 0 ? '\nall good' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
