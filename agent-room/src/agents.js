// Calls the real Claude Code and Codex CLIs. Each call is one stateless turn:
// the full room transcript goes in on stdin, one reply comes back.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { resolveCommand, run } from './proc.js';
import { systemPrompt, turnPrompt, cleanReply } from './prompts.js';

const TURN_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_SECONDS || 150) * 1000;

// Agents run in an empty scratch folder so they can't pick up project files or instructions.
const WORK_DIR = path.join(os.tmpdir(), 'agent-room', 'workspace');
const TMP_DIR = path.join(os.tmpdir(), 'agent-room', 'tmp');
mkdirSync(WORK_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });

export function authMode(agentId) {
  if (agentId === 'claude') {
    if (process.env.ANTHROPIC_API_KEY) return 'API key';
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return 'subscription token';
    return 'CLI login';
  }
  return process.env.OPENAI_API_KEY ? 'API key' : 'ChatGPT login';
}

const tail = (s, n = 600) => (s.length > n ? '…' + s.slice(-n) : s).trim();

/** Turn a failed run into a short message plus a concrete fix. */
function explainFailure(agentId, res, output) {
  const name = agentId === 'claude' ? 'Claude' : 'Codex';
  const text = `${output}\n${res.stderr}`;
  if (res.spawnError) {
    const install = agentId === 'claude' ? 'npm install -g @anthropic-ai/claude-code' : 'npm install -g @openai/codex';
    return res.spawnError === 'ENOENT'
      ? { error: `${name} CLI not found.`, hint: install }
      : { error: `${name} CLI could not start (${res.spawnError}).`, hint: `Check the install: ${install}` };
  }
  if (res.aborted) return { error: 'Stopped.', hint: '' };
  if (res.timedOut) return { error: `${name} didn't reply within ${TURN_TIMEOUT_MS / 1000}s.`, hint: 'Retry, or raise AGENT_TIMEOUT_SECONDS.' };
  if (/usage limit|rate.?limit|quota|429|too many requests/i.test(text)) {
    return { error: `${name} hit a usage or rate limit.`, hint: 'Wait for the plan limit to reset, then retry.' };
  }
  if (/not logged in|log ?in|authenticat|unauthori[sz]ed|401|expired|invalid api key|oauth/i.test(text)) {
    return {
      error: `${name} isn't signed in.`,
      hint:
        agentId === 'claude'
          ? 'Run `claude setup-token` and put the token in .env as CLAUDE_CODE_OAUTH_TOKEN (or set ANTHROPIC_API_KEY), then restart.'
          : 'Run `codex login` (Docker: see README, "Sign in to Codex"), then click Re-check.',
    };
  }
  return { error: `${name} returned an error.`, hint: tail(text, 300) || `Exit code ${res.code}` };
}

async function callClaude(prompt, system, { signal, model }) {
  const bin = resolveCommand('claude');
  if (!bin) return { ok: false, ...explainFailure('claude', { spawnError: 'ENOENT', stderr: '' }, '') };

  const systemFile = path.join(TMP_DIR, `claude-system-${randomUUID()}.txt`);
  writeFileSync(systemFile, system);
  const args = [
    '-p',
    '--output-format', 'json',
    '--tools', '', // brainstorm only: no file, shell or web tools
    '--no-session-persistence',
    '--setting-sources', 'project', // ignore the user's own hooks, plugins and settings
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--system-prompt-file', systemFile,
  ];
  if (model) args.push('--model', model);

  const res = await run(bin, args, { input: prompt, cwd: WORK_DIR, timeoutMs: TURN_TIMEOUT_MS, signal });
  rmSync(systemFile, { force: true });

  const jsonLine = res.stdout.split('\n').reverse().find((l) => l.trim().startsWith('{'));
  let data = null;
  try {
    data = jsonLine ? JSON.parse(jsonLine) : null;
  } catch {
    data = null;
  }
  const raw = { args, ...res };
  if (!data || data.is_error || res.code !== 0 || !data.result) {
    return { ok: false, raw, durationMs: res.durationMs, ...explainFailure('claude', res, data?.result || res.stdout) };
  }
  // Claude Code can use a small helper model (Haiku) on the side; report the one that wrote
  // the reply. On tiny replies the token counts can tie, so the helper ranks last.
  const isHelper = (name) => /haiku/i.test(name) && !/haiku/i.test(model || '');
  const writer = Object.entries(data.modelUsage || {}).sort(
    (a, b) => isHelper(a[0]) - isHelper(b[0]) || (b[1].outputTokens || 0) - (a[1].outputTokens || 0),
  )[0];
  return {
    ok: true,
    raw,
    text: data.result,
    model: writer?.[0] || model || null,
    durationMs: res.durationMs,
  };
}

async function callCodex(prompt, { signal, model }) {
  const bin = resolveCommand('codex');
  if (!bin) return { ok: false, ...explainFailure('codex', { spawnError: 'ENOENT', stderr: '' }, '') };

  const outFile = path.join(TMP_DIR, `codex-reply-${randomUUID()}.txt`);
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--ephemeral',
    '--ignore-user-config', // ignore the user's own Codex config and rules (auth still works)
    '--ignore-rules',
    '--color', 'never',
    '-C', WORK_DIR,
    '-o', outFile,
  ];
  if (model) args.push('-m', model);
  args.push('-'); // read the prompt from stdin

  const res = await run(bin, args, { input: prompt, cwd: WORK_DIR, timeoutMs: TURN_TIMEOUT_MS, signal });
  let text = '';
  try {
    text = readFileSync(outFile, 'utf8').trim();
  } catch {
    text = '';
  }
  rmSync(outFile, { force: true });

  const output = `${res.stdout}\n${res.stderr}`;
  const raw = { args, ...res };
  if (res.code !== 0 || !text) {
    return { ok: false, raw, durationMs: res.durationMs, ...explainFailure('codex', res, output) };
  }
  return {
    ok: true,
    raw,
    text,
    model: output.match(/^model:\s*(\S+)/m)?.[1] || model || null,
    durationMs: res.durationMs,
  };
}

/** One real turn for one agent, based on the current room transcript. */
export async function callAgent(agentId, room, { signal } = {}) {
  const system = systemPrompt(agentId);
  const turn = turnPrompt(agentId, room);
  const result =
    agentId === 'claude'
      ? await callClaude(turn, system, { signal, model: process.env.CLAUDE_MODEL })
      : await callCodex(`${system}\n\n---\n\n${turn}`, { signal, model: process.env.CODEX_MODEL });
  if (result.ok) result.text = cleanReply(agentId, result.text);
  result.prompt = { system, turn };
  return result;
}

/** Cheap connection test used by the start screen: one tiny real call per agent. */
export async function ping(agentId) {
  const fakeRoom = {
    title: 'Connection check',
    messages: [{ role: 'human', status: 'done', text: 'Connection check. Reply with exactly: OK' }],
  };
  return callAgent(agentId, fakeRoom);
}

export async function version(agentId) {
  const bin = resolveCommand(agentId);
  if (!bin) return null;
  const res = await run(bin, ['--version'], { timeoutMs: 20_000 });
  return res.code === 0 ? res.stdout.trim().split('\n')[0] : null;
}
