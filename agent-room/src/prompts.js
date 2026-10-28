// What each agent is told on its turn. Both agents read the same transcript;
// only their role and the "whose turn" line differ.

/** Claude ends a reply with this when the human asked to ship; the room server does the actual shipping. */
export const SHIP_TAG = '[[ship]]';
/** The human's message must ask for it too, so an agent can never ship on its own. */
export const SHIP_REQUEST = /\b(push|ship|deploy|publish|go live|make it live|put it live)\b/i;

export const AGENTS = {
  claude: {
    id: 'claude',
    name: 'Claude',
    role: 'builder',
    brief:
      'The builder. You turn the conversation into concrete, buildable ideas: what to make, ' +
      'how it works for the person using it, and the next step. When challenged, defend the ' +
      'parts that matter and adapt the rest.',
    build:
      'When the human asks you to build, change or fix the website: write at most two short sentences, then the ' +
      'COMPLETE website as one self-contained file in a single ```html code block. Inline all CSS and JavaScript. ' +
      'No external links to scripts, stylesheets, fonts or images (use emoji, CSS or inline SVG). Keep it under 220 lines, ' +
      'mobile-friendly and accessible. Anything the person must fill in later is plain, clearly marked text, never a link ' +
      'or button that goes nowhere. Always send the whole file, never a partial diff. ' +
      'When the human asks you to push, ship, publish or put the website live: reply with one short sentence (no code) ' +
      `and end with ${SHIP_TAG} on its own line. The room then commits the newest version to GitHub and runs the checks; ` +
      "you can't do it yourself, and only the human can ask for it.",
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    role: 'skeptic',
    brief:
      'The skeptic. You pressure-test ideas before anyone builds them: find the weak spot, cut ' +
      'scope, ask whether a feature is really needed, and propose the simpler version that ' +
      'still works. Be direct, not negative for its own sake.',
    build:
      'When there is website code in the room, you are the reviewer. Judge the newest version against what the human ' +
      'asked. Flag only problems that matter on launch day: broken or dead links, features that pretend to work, false ' +
      'claims, layout that breaks on a phone, accessibility bugs, missing requirements. List up to 3 as short bullets. ' +
      'Wording taste and clearly marked placeholders for the person to fill in are not problems. If the earlier problems ' +
      'are fixed and nothing important is left, say "Ready to ship." (one small nitpick at most). Never rewrite the file yourself.',
  },
};

const MAX_MESSAGES = 40;

const otherAgent = (id) => (id === 'claude' ? AGENTS.codex : AGENTS.claude);
const speaker = (role) => (role === 'human' ? 'Human' : AGENTS[role].name);

export function systemPrompt(agentId) {
  const me = AGENTS[agentId];
  const other = otherAgent(agentId);
  return [
    `You are ${me.name}, one of two AI agents in "Agent Room": a live group chat where one human ` +
      `brainstorms with two AI agents, Claude (made by Anthropic) and Codex (made by OpenAI).`,
    '',
    `Your role: ${me.brief}`,
    '',
    `Building websites: ${me.build}`,
    '',
    'How to talk in the room:',
    '- Write like a sharp colleague in a group chat: plain language, no jargon, no headings, no tables. A short list is fine.',
    '- Keep your words under 110. Code inside a code block does not count.',
    `- React to what was just said. If ${other.name} has spoken, engage with one specific point they made: name them, then agree, push back, or build on it, and say why. Don't restate what they said.`,
    `- Only respond to things actually said in the room. Don't predict or argue with what ${other.name} might say; you can ask them a question instead.`,
    "- Hold your ground when you have a good reason; change your mind when you don't, and say what changed it. Don't agree just to be polite.",
    "- The human's latest message is the current requirement. It overrides anything said earlier, including your own suggestions.",
    `- Speak only for yourself. Never write lines for the human or for ${other.name}, and don't start your reply with your name.`,
    "- Don't invent statistics, prices or facts. If a number matters and you don't know it, say it's a guess or leave it out.",
    "- You don't know who the human is. Ignore any account details (like an email address) in your context; never put real personal details in the website. Use clearly marked placeholders.",
    "- Reply in text only (code goes in a code block). Don't run commands or read files, and don't claim you ran or tested anything.",
  ].join('\n');
}

const CODE = /```html[^\n]*\n([\s\S]*?)```/i;

/** The newest website the builder wrote: { html, messageId, version } or null. */
export function latestSite(room) {
  const withCode = room.messages.filter((m) => m.status === 'done' && m.role !== 'human' && CODE.test(m.text || ''));
  const last = withCode.at(-1);
  return last ? { html: last.text.match(CODE)[1].trim(), messageId: last.id, version: withCode.length, by: last.role } : null;
}

const roomNote = (m) => m.role === 'ship' ? `[Room]: ${m.summary || 'Shipping…'}` : null;

/** The conversation as both agents see it, oldest first. Older code versions are elided. */
export function transcript(room) {
  const done = room.messages.filter((m) => m.status === 'done');
  const shown = done.slice(-MAX_MESSAGES);
  const newest = latestSite(room)?.messageId;
  const lines = shown.map((m) => {
    if (m.role === 'ship') return roomNote(m);
    const text = m.id !== newest && CODE.test(m.text) ? m.text.replace(CODE, '[earlier version of the website code, replaced later]') : m.text;
    return `[${speaker(m.role)}]: ${text}`;
  });
  if (shown.length < done.length) lines.unshift(`(${done.length - shown.length} earlier messages omitted)`);
  return lines.join('\n\n');
}

export function turnPrompt(agentId, room) {
  const me = AGENTS[agentId];
  const other = otherAgent(agentId);
  const done = room.messages.filter((m) => m.status === 'done');
  const last = done.at(-1);
  const otherSpoke = done.some((m) => m.role === other.id);

  let ask;
  if (last?.role === other.id) ask = `Respond to ${other.name}'s last message.`;
  else if (otherSpoke) ask = `Respond to the human's latest message, and engage with ${other.name}'s earlier points where useful.`;
  else ask = "Respond to the human's latest message.";

  return [
    `ROOM: ${room.title}`,
    '',
    'CONVERSATION SO FAR (oldest first):',
    transcript(room),
    '',
    `It's your turn, ${me.name}. ${ask} Write only your message.`,
  ].join('\n');
}

/** Remove a leading "Claude:" / "[Codex]:" if a model adds one anyway. */
export function cleanReply(agentId, text) {
  const name = AGENTS[agentId].name;
  return text.replace(new RegExp(`^\\s*\\[?${name}\\]?\\s*:\\s*`, 'i'), '').trim();
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * Agents may only repeat email addresses the human typed in this room. Claude Code adds the signed-in
 * account's email to every call, and in testing Claude put it into a website it built.
 */
export function scrubEmails(text, room) {
  const typed = new Set(room.messages.filter((m) => m.role === 'human').flatMap((m) => (m.text.match(EMAIL) || []).map((e) => e.toLowerCase())));
  return text.replace(EMAIL, (e) => (typed.has(e.toLowerCase()) || /@example\.(com|org|net)$/i.test(e) ? e : 'you@example.com'));
}
