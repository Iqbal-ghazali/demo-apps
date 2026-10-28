// Agent Room browser client (Preact + htm, no build step).
// The server pushes changes over SSE; this file renders them and sends your actions back.

import { html, render, useState, useEffect, useRef, useMemo, useCallback } from '/vendor/htm-preact.js';
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

const AGENT_IDS = ['claude', 'codex'];
const NAMES = { human: 'You', claude: 'Claude', codex: 'Codex' };
const INITIALS = { claude: 'CL', codex: 'CX' };

// ---------- Small helpers ----------

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const systemDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches;
document.documentElement.dataset.theme = store.get('theme') || (systemDark() ? 'dark' : 'light');

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Agent-Room': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Agent text is Markdown. Render it, then sanitize: model output never reaches the DOM unfiltered.
marked.setOptions({ gfm: true, breaks: true });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
const markdown = (text) => DOMPurify.sanitize(marked.parse(text), { FORBID_TAGS: ['img', 'style', 'form', 'input'], FORBID_ATTR: ['style'] });

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const oneLine = (text) => text.replace(/\s+/g, ' ').trim();
const CODE = /```html[^\n]*\n([\s\S]*?)```/i;
/** Split a reply into prose before/after its website code block. */
function splitCode(text) {
  const m = text.match(CODE);
  if (!m) return { before: text, code: null, after: '' };
  return { before: text.slice(0, m.index).trim(), code: m[1].trim(), after: text.slice(m.index + m[0].length).trim() };
}
/** Newest website in the room (mirrors the server's latestSite). */
function latestSite(room) {
  const withCode = room.messages.filter((m) => m.status === 'done' && m.role !== 'human' && m.role !== 'ship' && CODE.test(m.text || ''));
  const last = withCode.at(-1);
  return last ? { messageId: last.id, version: withCode.length, versions: new Map(withCode.map((m, i) => [m.id, i + 1])) } : null;
}

const roomFromHash = () => location.hash.match(/^#\/r\/([\w-]+)$/)?.[1] || null;

const Icon = ({ name }) => html`<svg class="icon" aria-hidden="true"><use href=${`/icons.svg#${name}`} /></svg>`;

// ---------- Server connection ----------

function useServer() {
  const [meta, setMeta] = useState(null);
  const [rooms, setRooms] = useState({});
  const [connection, setConnection] = useState(0);
  const offset = useRef(0);

  useEffect(() => {
    const events = new EventSource('/api/events');
    events.addEventListener('open', () => setConnection((n) => n + 1));
    events.addEventListener('meta', (e) => {
      const m = JSON.parse(e.data);
      offset.current = m.serverNow - Date.now();
      setMeta(m);
    });
    events.addEventListener('room', (e) => {
      const room = JSON.parse(e.data);
      setRooms((all) => ({ ...all, [room.id]: room }));
    });
    return () => events.close();
  }, []);

  return { meta, rooms, setRooms, offset, connection };
}

// ---------- Components ----------

function Elapsed({ since, offset }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);
  return html`<span class="elapsed">${(Math.max(0, now + offset.current - since) / 1000).toFixed(1)}s</span>`;
}

function CodeChip({ code, version }) {
  const [open, setOpen] = useState(false);
  const lines = code.split('\n').length;
  return html`<div class="code-chip">
    <button class="code-head" onClick=${() => setOpen((o) => !o)}>
      <${Icon} name="file-code" /><b>index.html</b><span>${lines} lines${version ? ` · v${version}` : ''}</span><em>${open ? 'Hide code' : 'View code'}</em>
    </button>
    ${open && html`<pre class="code"><code>${code}</code></pre>`}
  </div>`;
}

const STEP_LABELS = { commit: 'Commit to GitHub', test: 'Tests · GitHub Actions', deploy: 'Deploy · GitHub Pages', live: 'Live' };
const STEP_ICON = { done: 'circle-check', failed: 'circle-x', running: 'loader-circle', skipped: 'minus', waiting: 'minus' };

function ShipCard({ m }) {
  const steps = m.steps || {};
  const links = m.links || {};
  const failed = m.failed || m.status === 'error';
  return html`<li class="msg ship">
    <div class="ship-card ${failed ? 'failed' : m.status === 'done' ? 'shipped' : ''}">
      <div class="ship-title"><${Icon} name="rocket" /> Shipping v${m.version} <span>→ ${m.repo}</span></div>
      <ol class="ship-steps">
        ${Object.entries(STEP_LABELS).map(([k, label]) => {
          const st = steps[k] || (m.status === 'error' ? 'failed' : 'waiting');
          const href = k === 'commit' ? links.commit : k === 'live' ? m.url : links.run;
          return html`<li class="st-${st}"><${Icon} name=${STEP_ICON[st]} />${href && st !== 'waiting' ? html`<a href=${href} target="_blank" rel="noopener noreferrer">${label}</a>` : label}</li>`;
        })}
      </ol>
      ${m.url && !failed && html`<a class="live-link" href=${m.url} target="_blank" rel="noopener noreferrer"><${Icon} name="globe" /> ${m.url.replace(/^https?:\/\//, '')}</a>`}
      ${failed && html`<div class="ship-err">${m.summary || m.error}</div>`}
    </div>
  </li>`;
}

function Message({ m, target, agents, offset, busy, onRetry, version }) {
  const parts = useMemo(() => (m.status === 'done' && m.role !== 'human' && m.role !== 'ship' ? splitCode(m.text) : null), [m.text, m.status]);
  const rendered = useMemo(() => parts && { before: markdown(parts.before), after: parts.after ? markdown(parts.after) : '' }, [parts]);
  if (m.role === 'ship') return html`<${ShipCard} m=${m} />`;

  if (m.role === 'human') {
    return html`<li class="msg human">
      <div class="msg-body">
        <div class="bubble">${m.text}</div>
        <div class="meta">${clock(m.at)}</div>
      </div>
    </li>`;
  }

  // Keys make Preact swap the element when the status changes instead of patching it,
  // so nothing from the "thinking" state lingers inside the finished reply.
  let content;
  if (m.status === 'done') {
    content = html`<div key="done">
      <div class="md" dangerouslySetInnerHTML=${{ __html: rendered.before }} />
      ${parts.code && html`<${CodeChip} code=${parts.code} version=${version} />`}
      ${rendered.after && html`<div class="md" dangerouslySetInnerHTML=${{ __html: rendered.after }} />`}
    </div>`;
  }
  else if (m.status === 'pending') {
    content = html`<div key="pending" class="thinking"><span class="dots"><i /><i /><i /></span> thinking <${Elapsed} since=${m.startedAt} offset=${offset} /></div>`;
  } else if (m.status === 'error') {
    content = html`<div key="error">
      ${m.error}
      ${m.hint && html`<code>${m.hint}</code>`}
      <button class="link-btn" disabled=${busy} onClick=${() => onRetry(m.id)}>Retry</button>
    </div>`;
  } else content = html`<div key="stopped">Stopped</div>`;

  return html`<li class="msg ${m.role} ${m.status}">
    <div class="avatar ${m.role}">${INITIALS[m.role]}</div>
    <div class="msg-body">
      <div class="msg-head"><span class="msg-name">${NAMES[m.role]}</span><span class="role">${agents[m.role].role}</span></div>
      ${target?.text && target.role !== 'ship' && html`<div class="quote ${target.role}"><b>${NAMES[target.role]}</b><span>${oneLine(splitCode(target.text).code ? `${splitCode(target.text).before} [website code]` : target.text)}</span></div>`}
      <div class="bubble">${content}</div>
      ${m.status === 'done' &&
      html`<div class="meta" title=${m.durationMs ? `Replied in ${(m.durationMs / 1000).toFixed(1)}s` : ''}>${m.model ? `${m.model} · ` : ''}${clock(m.at)}</div>`}
    </div>
  </li>`;
}

function Composer({ busy, onSend, onContinue, onStop, canContinue, placeholder, autofocus }) {
  const [text, setText] = useState('');
  const ref = useRef();

  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
    el.style.overflowY = el.scrollHeight > 220 ? 'auto' : 'hidden';
  };
  useEffect(() => {
    if (autofocus) ref.current?.focus();
  }, []);

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    if (await onSend(t)) {
      setText('');
      requestAnimationFrame(grow);
    }
  };

  return html`<div class="composer">
    <textarea
      ref=${ref}
      rows="1"
      maxlength="4000"
      placeholder=${placeholder}
      value=${text}
      onInput=${(e) => { setText(e.target.value); grow(); }}
      onKeyDown=${(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          submit();
        }
      }}
    />
    <div class="composer-bar">
      ${onContinue &&
      html`<button class="pill" disabled=${busy || !canContinue} onClick=${onContinue} title="Let Claude and Codex go another round">
        <${Icon} name="rotate-cw" /> Continue
      </button>`}
      <span class="hint">${onContinue && html`<b>@claude</b> or <b>@codex</b> to ask one`}</span>
      ${busy
        ? html`<button class="send stop" onClick=${onStop} title="Stop" aria-label="Stop"><${Icon} name="square" /></button>`
        : html`<button class="send" disabled=${!text.trim()} onClick=${submit} title="Send" aria-label="Send"><${Icon} name="arrow-up" /></button>`}
    </div>
  </div>`;
}

function Chat({ room, agents, offset, actions }) {
  const scroller = useRef();
  const pinned = useRef(true);
  const byId = useMemo(() => new Map(room.messages.map((m) => [m.id, m])), [room]);
  const versions = useMemo(() => latestSite(room)?.versions || new Map(), [room]);

  useEffect(() => {
    pinned.current = true;
  }, [room.id]);
  useEffect(() => {
    if (pinned.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  });

  return html`<div class="chat-pane">
    <div class="scroller" ref=${scroller} onScroll=${(e) => {
      const el = e.currentTarget;
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    }}>
      <div class="column">
        <ol class="messages">
          ${room.messages.map((m) => html`<${Message} key=${m.id} m=${m} target=${byId.get(m.replyTo)} agents=${agents} offset=${offset} busy=${room.busy} onRetry=${actions.retry} version=${versions.get(m.id)} />`)}
        </ol>
      </div>
    </div>
    <div class="column composer-wrap">
      <${Composer}
        busy=${room.busy}
        canContinue=${room.messages.some((m) => m.status === 'done')}
        placeholder="Message Claude and Codex…"
        onSend=${actions.send}
        onContinue=${actions.continue}
        onStop=${actions.stop}
        autofocus
      />
    </div>
  </div>`;
}

/** The newest website, running in a sandboxed frame (its own origin, no network). */
function Preview({ room, site, ship, onShip }) {
  const disabled = !ship.enabled || room.busy || room.shipping;
  const title = !ship.enabled ? 'Set GITHUB_TOKEN and GITHUB_REPO in .env to enable shipping' : `Commit to ${ship.repo}, run tests, deploy to GitHub Pages`;
  return html`<aside class="preview">
    <div class="preview-bar">
      <span class="pv-title"><${Icon} name="globe" /> Preview <em>v${site.version}</em></span>
      <a class="icon-btn" href=${`/preview/${room.id}`} target="_blank" rel="noopener noreferrer" title="Open in a new tab" aria-label="Open preview in a new tab"><${Icon} name="external-link" /></a>
      <button class="ship-btn" disabled=${disabled} onClick=${onShip} title=${title}><${Icon} name="rocket" /> ${room.shipping ? 'Shipping…' : 'Ship'}</button>
    </div>
    <iframe key=${site.messageId} src=${`/preview/${room.id}?v=${site.messageId}`} sandbox="allow-scripts" title="Website preview"></iframe>
  </aside>`;
}

function Home({ meta, onCreate }) {
  const problems = AGENT_IDS.map((id) => meta.health.agents[id]).filter((a) => a && !a.ok);
  return html`<div class="home column">
    <h1>What should we brainstorm?</h1>
    <p>Claude and Codex share one conversation with you.</p>
    <${Composer} placeholder="Describe a problem or an idea…" onSend=${onCreate} autofocus />
    ${problems.map((a) => html`<div class="warn">${NAMES[a.id]}: ${a.error} ${a.hint && html`<code>${a.hint}</code>`}</div>`)}
  </div>`;
}

function People({ room, agents }) {
  return html`<div class="people">
    ${AGENT_IDS.map((id) => {
      const typing = room.messages.some((m) => m.role === id && m.status === 'pending');
      return html`<span class="person ${id} ${typing ? 'typing' : ''}">
        <span class="avatar ${id}">${INITIALS[id]}</span>${agents[id].name}${typing && html`<em>typing…</em>`}
      </span>`;
    })}
  </div>`;
}

function Connection({ id, health }) {
  const a = health.agents[id];
  const state = health.checking || !a ? 'pending' : a.ok ? 'ok' : 'fail';
  const label = state === 'pending' ? 'connecting…' : a.ok ? a.model || 'connected' : 'offline';
  const title = a && !a.ok ? `${a.error} ${a.hint || ''}` : a ? [a.version, a.auth].filter(Boolean).join(' · ') : '';
  return html`<div class="conn ${state}" title=${title}><span class="dot" /><b>${NAMES[id]}</b><span class="model">${label}</span></div>`;
}

function Sidebar({ meta, activeId, theme, actions }) {
  return html`<aside class="sidebar">
    <div class="side-head">
      <div class="brand">Agent Room</div>
      <button class="icon-btn" onClick=${actions.toggleSidebar} title="Hide sidebar" aria-label="Hide sidebar"><${Icon} name="panel-left" /></button>
    </div>
    <button class="new-btn" onClick=${actions.newRoom}><${Icon} name="plus" /> New room</button>
    <div class="side-label">Rooms</div>
    <ul class="room-list">
      ${meta.rooms.length
        ? meta.rooms.map((r) => html`<li key=${r.id} class="room-item ${r.id === activeId ? 'active' : ''}">
            <a href=${`#/r/${r.id}`} title=${r.title}>
              ${r.busy ? html`<span class="live-dot" />` : html`<${Icon} name="message-square" />`}<span>${r.title}</span>
            </a>
            <button class="icon-btn" onClick=${() => actions.deleteRoom(r)} title="Delete room" aria-label="Delete room"><${Icon} name="trash-2" /></button>
          </li>`)
        : html`<li class="empty-list">No rooms yet</li>`}
    </ul>
    <div class="side-foot">
      ${AGENT_IDS.map((id) => html`<${Connection} id=${id} health=${meta.health} />`)}
      <div class="foot-actions">
        <button class="icon-btn" onClick=${actions.recheck} disabled=${meta.health.checking} title="Re-check connections" aria-label="Re-check connections"><${Icon} name="refresh-cw" /></button>
        <button class="icon-btn" onClick=${actions.toggleTheme} title="Toggle theme" aria-label="Toggle theme"><${Icon} name=${theme === 'dark' ? 'sun' : 'moon'} /></button>
      </div>
    </div>
  </aside>`;
}

function App() {
  const { meta, rooms, setRooms, offset, connection } = useServer();
  const [activeId, setActiveId] = useState(roomFromHash());
  const [collapsed, setCollapsed] = useState(store.get('sidebar') === 'hidden' || window.innerWidth < 860);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    const onHash = () => setActiveId(roomFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Load the open room (also after a reconnect, in case the server restarted).
  useEffect(() => {
    if (!activeId) return;
    api('GET', `/api/rooms/${activeId}`)
      .then((room) => setRooms((all) => ({ ...all, [room.id]: room })))
      .catch(() => (location.hash = '#/'));
  }, [activeId, connection]);

  const flash = useCallback((text) => {
    setToast(text);
    clearTimeout(flash.t);
    flash.t = setTimeout(() => setToast(null), 3500);
  }, []);
  const attempt = async (fn) => {
    try {
      await fn();
      return true;
    } catch (err) {
      flash(err.message);
      return false;
    }
  };

  const narrow = () => window.innerWidth < 860;
  const actions = {
    newRoom: () => {
      location.hash = '#/';
      if (narrow()) setCollapsed(true);
    },
    create: (text) => attempt(async () => {
      const { id } = await api('POST', '/api/rooms', { text });
      location.hash = `#/r/${id}`;
    }),
    send: (text) => attempt(() => api('POST', `/api/rooms/${activeId}/messages`, { text })),
    continue: () => attempt(() => api('POST', `/api/rooms/${activeId}/continue`)),
    stop: () => attempt(() => api('POST', `/api/rooms/${activeId}/stop`)),
    retry: (messageId) => attempt(() => api('POST', `/api/rooms/${activeId}/retry`, { messageId })),
    ship: () => attempt(() => api('POST', `/api/rooms/${activeId}/ship`)),
    deleteRoom: (r) => {
      if (!confirm(`Delete "${r.title}"?`)) return;
      attempt(async () => {
        await api('DELETE', `/api/rooms/${r.id}`);
        setRooms(({ [r.id]: _, ...rest }) => rest);
        if (r.id === activeId) location.hash = '#/';
      });
    },
    recheck: () => attempt(() => api('POST', '/api/recheck')),
    toggleSidebar: () => setCollapsed((c) => {
      store.set('sidebar', c ? 'shown' : 'hidden');
      return !c;
    }),
    toggleTheme: () => {
      const next = theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      store.set('theme', next);
      setTheme(next);
    },
  };

  if (!meta) return null;
  const room = activeId ? rooms[activeId] : null;
  const site = room ? latestSite(room) : null;

  return html`<div class="shell ${collapsed ? 'collapsed' : ''}">
    <${Sidebar} meta=${meta} activeId=${activeId} theme=${theme} actions=${actions} />
    <main class="main">
      <header class="topbar ${room ? '' : 'bare'}">
        ${collapsed && html`<button class="icon-btn" onClick=${actions.toggleSidebar} title="Show sidebar" aria-label="Show sidebar"><${Icon} name="panel-left" /></button>`}
        <div class="room-title">${room?.title || ''}</div>
        ${room && html`<${People} room=${room} agents=${meta.agents} />`}
        ${room && html`<a class="icon-btn" href=${`/api/rooms/${room.id}/export`} title="Export chat" aria-label="Export chat"><${Icon} name="download" /></a>`}
      </header>
      ${room
        ? html`<div class="workspace">
            <${Chat} key=${room.id} room=${room} agents=${meta.agents} offset=${offset} actions=${actions} />
            ${site && html`<${Preview} room=${room} site=${site} ship=${meta.ship || {}} onShip=${actions.ship} />`}
          </div>`
        : activeId
          ? null
          : html`<${Home} meta=${meta} onCreate=${actions.create} />`}
    </main>
    ${toast && html`<div class="toast" role="status">${toast}</div>`}
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
