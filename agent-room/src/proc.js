// Cross-platform helpers for running the agent CLIs as child processes.
// User text never goes into command-line arguments: prompts are sent on stdin.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';
const MAX_OUTPUT = 2 * 1024 * 1024;

/** Find an executable on PATH. On Windows, native .exe files win over npm .cmd shims. */
export function resolveCommand(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? ['.exe', '.cmd', '.bat'] : [''];
  for (const ext of exts) {
    for (const dir of dirs) {
      const file = path.join(dir, name + ext);
      try {
        if (existsSync(file) && statSync(file).isFile()) return file;
      } catch {
        // unreadable PATH entry: skip
      }
    }
  }
  return null;
}

// Windows can't spawn .cmd files without a shell. npm shims just run a JS file with
// node, so we run that file directly and avoid cmd.exe quoting entirely.
function toSpawnable(file, args) {
  if (!isWin || !/\.(cmd|bat)$/i.test(file)) return { command: file, args };
  const shim = readFileSync(file, 'utf8');
  const match = shim.match(/"%~?dp0%?\\([^"]+\.js)"/i);
  if (match) {
    return { command: process.execPath, args: [path.join(path.dirname(file), match[1]), ...args] };
  }
  const quote = (a) => `"${String(a).replace(/"/g, '""')}"`;
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${[file, ...args].map(quote).join(' ')}"`],
    verbatim: true,
  };
}

/** Kill a child process and everything it started. */
export function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Run a command, write `input` to stdin, collect output.
 * Resolves (never rejects) with { code, stdout, stderr, durationMs, timedOut, aborted, spawnError }.
 */
export function run(file, args, { input = '', cwd, env = process.env, timeoutMs = 120_000, signal } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const target = toSpawnable(file, args);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(target.command, target.args, {
      cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: Boolean(target.verbatim),
      detached: !isWin, // own process group on POSIX, so killTree reaches grandchildren
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, durationMs: Date.now() - started, timedOut, aborted, ...extra });
    };
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d; });
    child.on('error', (err) => finish({ code: null, spawnError: err.code || err.message }));
    child.on('close', (code) => finish({ code }));
    child.stdin.on('error', () => {}); // child may exit before reading stdin
    child.stdin.end(input);
  });
}
