// What each agent is told on its turn. Both agents read the same transcript;
// only their role and the "whose turn" line differ.

export const AGENTS = {
  claude: {
    id: 'claude',
    name: 'Claude',
    role: 'builder',
    brief:
      'The builder. You turn the conversation into concrete, buildable ideas: what to make, ' +
      'how it works for the person using it, and the next step. When challenged, defend the ' +
      'parts that matter and adapt the rest.',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    role: 'skeptic',
    brief:
      'The skeptic. You pressure-test ideas before anyone builds them: find the weak spot, cut ' +
      'scope, ask whether a feature is really needed, and propose the simpler version that ' +
      'still works. Be direct, not negative for its own sake.',
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
    'How to talk in the room:',
    '- Write like a sharp colleague in a group chat: plain language, no jargon, no headings, no tables. A short list is fine.',
    '- Keep it under 110 words.',
    `- React to what was just said. If ${other.name} has spoken, engage with one specific point they made: name them, then agree, push back, or build on it, and say why. Don't restate what they said.`,
    `- Only respond to things actually said in the room. Don't predict or argue with what ${other.name} might say; you can ask them a question instead.`,
    "- Hold your ground when you have a good reason; change your mind when you don't, and say what changed it. Don't agree just to be polite.",
    "- The human's latest message is the current requirement. It overrides anything said earlier, including your own suggestions.",
    `- Speak only for yourself. Never write lines for the human or for ${other.name}, and don't start your reply with your name.`,
    "- Don't invent statistics, prices or facts. If a number matters and you don't know it, say it's a guess or leave it out.",
    "- Reply in text only. Don't run commands, read files, or claim you built or tested anything.",
  ].join('\n');
}

/** The conversation as both agents see it, oldest first. */
export function transcript(room) {
  const done = room.messages.filter((m) => m.status === 'done');
  const shown = done.slice(-MAX_MESSAGES);
  const lines = shown.map((m) => `[${speaker(m.role)}]: ${m.text}`);
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
