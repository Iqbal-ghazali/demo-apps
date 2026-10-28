// Connection check shown on the start screen: is each CLI installed, and does a
// real one-line call succeed with the credentials it finds?

import { authMode, ping, version } from './agents.js';

const ids = ['claude', 'codex'];

async function checkAgent(id) {
  const started = Date.now();
  const v = await version(id);
  if (!v) {
    const install = id === 'claude' ? 'npm install -g @anthropic-ai/claude-code' : 'npm install -g @openai/codex';
    return { id, ok: false, version: null, auth: authMode(id), error: 'CLI not installed.', hint: install };
  }
  if (process.env.SKIP_PING === '1') {
    return { id, ok: true, version: v, auth: authMode(id), model: null, ms: Date.now() - started, skipped: true };
  }
  const res = await ping(id);
  return {
    id,
    ok: res.ok,
    version: v,
    auth: authMode(id),
    model: res.model || null,
    ms: Date.now() - started,
    error: res.ok ? null : res.error,
    hint: res.ok ? null : res.hint,
  };
}

export class Health {
  constructor() {
    this.state = { checking: false, checkedAt: null, agents: {} };
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  async check() {
    if (this.state.checking) return this.state;
    this.state = { ...this.state, checking: true };
    this.listeners.forEach((fn) => fn());
    const results = await Promise.all(ids.map(checkAgent));
    this.state = { checking: false, checkedAt: Date.now(), agents: Object.fromEntries(results.map((r) => [r.id, r])) };
    this.listeners.forEach((fn) => fn());
    return this.state;
  }

  get allOk() {
    return ids.every((id) => this.state.agents[id]?.ok);
  }
}
