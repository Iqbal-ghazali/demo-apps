// Rooms: each room is one transcript with one turn queue. Agents in a room speak one at a
// time, so each reply is written with everything said before it in view. Rooms are saved
// as JSON so sessions survive a restart.

import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callAgent } from './agents.js';

const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const ROOM_DIR = path.join(DATA_DIR, 'rooms');
const LOG_DIR = path.join(DATA_DIR, 'logs');
mkdirSync(ROOM_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

const DEFAULT_ROUND = ['claude', 'codex'];

/** "@codex what do you think?" → only Codex replies. No mention → both, Claude first. */
function roundFor(text) {
  const c = /@claude\b/i.test(text);
  const x = /@codex\b/i.test(text);
  if (c && !x) return ['claude'];
  if (x && !c) return ['codex'];
  return [...DEFAULT_ROUND];
}

/** Short sidebar title from the first message. */
function titleFrom(text) {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 60)}…`;
}

export class Room extends EventEmitter {
  constructor(data) {
    super();
    this.data = data;
    this.queue = [];
    this.controller = null;
  }

  get id() {
    return this.data.id;
  }

  get busy() {
    return Boolean(this.controller) || this.queue.length > 0;
  }

  toJSON() {
    return { ...this.data, busy: this.busy };
  }

  summary() {
    const { id, title, createdAt, updatedAt, messages } = this.data;
    return { id, title, createdAt, updatedAt, busy: this.busy, count: messages.length };
  }

  changed() {
    this.data.updatedAt = Date.now();
    this.emit('change', this);
  }

  log(entry) {
    appendFileSync(path.join(LOG_DIR, `room-${this.id}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  }

  say(text) {
    if (this.busy) throw new Error('Wait for the agents to finish, or press Stop.');
    this.data.messages.push({ id: randomUUID(), role: 'human', status: 'done', text, at: Date.now() });
    this.log({ event: 'human', text });
    this.queue = roundFor(text);
    this.changed();
    this.drain();
  }

  continue() {
    if (this.busy) throw new Error('The agents are already talking.');
    if (!this.data.messages.some((m) => m.status === 'done')) throw new Error('Say something first.');
    this.queue = [...DEFAULT_ROUND];
    this.changed();
    this.drain();
  }

  stop() {
    this.queue = [];
    this.controller?.abort();
  }

  retry(messageId) {
    if (this.busy) throw new Error('The agents are already talking.');
    const i = this.data.messages.findIndex((m) => m.id === messageId);
    const msg = this.data.messages[i];
    if (!msg || msg.status !== 'error') throw new Error('Nothing to retry.');
    this.data.messages.splice(i, 1);
    this.queue = [msg.role, ...(msg.remaining || [])];
    this.changed();
    this.drain();
  }

  async drain() {
    if (this.controller) return;
    while (this.queue.length) {
      const agentId = this.queue.shift();
      const done = this.data.messages.filter((m) => m.status === 'done');
      const msg = { id: randomUUID(), role: agentId, status: 'pending', replyTo: done.at(-1)?.id || null, startedAt: Date.now() };
      this.data.messages.push(msg);
      this.controller = new AbortController();
      this.changed();

      const result = await callAgent(agentId, this.data, { signal: this.controller.signal });
      this.controller = null;
      if (this.deleted) return;

      this.log({
        event: 'turn',
        agent: agentId,
        ok: result.ok,
        model: result.model,
        durationMs: result.durationMs,
        prompt: result.prompt,
        reply: result.text,
        error: result.error,
        exitCode: result.raw?.code,
        stderrTail: result.raw?.stderr?.slice(-2000),
      });

      msg.durationMs = result.durationMs;
      delete msg.startedAt;
      if (result.ok) {
        Object.assign(msg, { status: 'done', text: result.text, model: result.model, at: Date.now() });
      } else if (result.raw?.aborted) {
        Object.assign(msg, { status: 'stopped', at: Date.now() });
        this.queue = [];
      } else {
        // Keep the rest of the round so Retry can pick up where it failed.
        Object.assign(msg, { status: 'error', error: result.error, hint: result.hint, remaining: [...this.queue], at: Date.now() });
        this.queue = [];
      }
      this.changed();
    }
  }

  exportMarkdown() {
    const name = { human: 'Human', claude: 'Claude', codex: 'Codex' };
    const lines = [`# ${this.data.title}`, '', `Agent Room export · ${new Date().toISOString()}`, ''];
    for (const m of this.data.messages) {
      if (m.status === 'done') {
        const meta = m.role === 'human' ? '' : ` _(${m.model || 'model unknown'}, ${(m.durationMs / 1000).toFixed(1)}s)_`;
        lines.push(`**${name[m.role]}**${meta}`, '', m.text, '');
      } else if (m.status === 'error') {
        lines.push(`**${name[m.role]}** _(failed: ${m.error})_`, '');
      }
    }
    return lines.join('\n');
  }
}

export class Rooms extends EventEmitter {
  constructor() {
    super();
    this.rooms = new Map();
    for (const file of readdirSync(ROOM_DIR).filter((f) => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(readFileSync(path.join(ROOM_DIR, file), 'utf8'));
        // A reply that was in progress when the server stopped can't be resumed.
        for (const m of data.messages) {
          if (m.status === 'pending') Object.assign(m, { status: 'error', error: 'Interrupted: the server restarted.', hint: '', remaining: [] });
        }
        this.attach(new Room(data));
      } catch (err) {
        console.warn(`Skipping unreadable room file ${file}: ${err.message}`);
      }
    }
  }

  attach(room) {
    this.rooms.set(room.id, room);
    room.on('change', () => {
      this.save(room);
      this.emit('change', room);
    });
  }

  save(room) {
    const file = path.join(ROOM_DIR, `${room.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(room.data));
    renameSync(`${file}.tmp`, file); // atomic replace: never a half-written room
  }

  list() {
    return [...this.rooms.values()].map((r) => r.summary()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id) {
    const room = this.rooms.get(id);
    if (!room) throw new Error('Room not found.');
    return room;
  }

  create(text) {
    const now = Date.now();
    const id = `${new Date(now).toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    const room = new Room({ id, title: titleFrom(text), createdAt: now, updatedAt: now, messages: [] });
    this.attach(room);
    room.log({ event: 'open', title: room.data.title });
    room.say(text);
    return room;
  }

  remove(id) {
    const room = this.get(id);
    room.deleted = true;
    room.stop();
    room.removeAllListeners();
    this.rooms.delete(id);
    rmSync(path.join(ROOM_DIR, `${id}.json`), { force: true });
    this.emit('removed', id);
  }
}
