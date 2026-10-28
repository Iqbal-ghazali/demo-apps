// "Ship": the room server (never the agents) commits the newest website to a GitHub repo,
// then follows the repo's GitHub Actions run (tests → deploy to GitHub Pages) until the site is live.
// Optional: enabled only when GITHUB_TOKEN and GITHUB_REPO are set. The repo can start empty:
// the first ship adds the test + deploy workflow from ship-template/ and turns on GitHub Pages.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ship-template');
const TEMPLATE_FILES = ['.github/workflows/deploy.yml', 'tests/check.mjs'];
const API = 'https://api.github.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function shipConfig() {
  const repo = process.env.GITHUB_REPO || '';
  return {
    enabled: Boolean(process.env.GITHUB_TOKEN && /^[\w.-]+\/[\w.-]+$/.test(repo)),
    repo,
    branch: process.env.GITHUB_BRANCH || 'main',
    path: process.env.GITHUB_SITE_PATH || 'site/index.html',
  };
}

async function gh(method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'agent-room',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `GitHub API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function explain(err) {
  if (err.status === 401) return 'GitHub rejected the token. Check GITHUB_TOKEN.';
  if (err.status === 403) return 'The token lacks permission (needs Contents and Workflows: write, Actions: read on this repo).';
  if (err.status === 404) return `Repo ${shipConfig().repo} not found, or the token can't see it.`;
  return err.message;
}

const exists = (p) => p.then(() => true, (err) => (err.status === 404 ? false : Promise.reject(err)));

async function commitSite(repo, branch, sitePath, html, message) {
  let head;
  try {
    head = await gh('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  } catch (err) {
    if (err.status !== 404 && err.status !== 409) throw err;
    // Brand-new empty repo: the Git Data API needs one commit to build on.
    await gh('PUT', `/repos/${repo}/contents/README.md`, { message: 'Start the site repo', branch, content: Buffer.from('# Website\n\nShipped from Agent Room.\n').toString('base64') });
    head = await gh('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  }
  const files = [{ path: sitePath, content: html }];
  if (!(await exists(gh('GET', `/repos/${repo}/contents/${TEMPLATE_FILES[0]}?ref=${encodeURIComponent(branch)}`)))) {
    for (const f of TEMPLATE_FILES) files.push({ path: f, content: readFileSync(path.join(TEMPLATE_DIR, f), 'utf8') });
    await enablePages(repo);
  }
  const parent = await gh('GET', `/repos/${repo}/git/commits/${head.object.sha}`);
  const tree = await gh('POST', `/repos/${repo}/git/trees`, {
    base_tree: parent.tree.sha,
    tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
  });
  const commit = await gh('POST', `/repos/${repo}/git/commits`, { message, tree: tree.sha, parents: [parent.sha] });
  await gh('PATCH', `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha });
  return { commit: commit.sha, html_url: `https://github.com/${repo}/commit/${commit.sha}` };
}

/** Deploys go through GitHub Actions, so Pages must use the "GitHub Actions" source. */
async function enablePages(repo) {
  if (await exists(gh('GET', `/repos/${repo}/pages`))) return;
  try {
    await gh('POST', `/repos/${repo}/pages`, { build_type: 'workflow' });
  } catch (err) {
    if (err.status !== 403 && err.status !== 404) throw err;
    throw new Error('GitHub Pages is off. Turn it on in the repo: Settings → Pages → Source: GitHub Actions. Then ship again.');
  }
}

/**
 * Commit the site and follow CI/CD. `update(patch)` is called with progress:
 * { steps: { commit, test, deploy, live }, links: {...}, url, summary, done, failed }
 */
export async function ship(html, commitMessage, update) {
  const { repo, branch, path } = shipConfig();
  const steps = { commit: 'running', test: 'waiting', deploy: 'waiting', live: 'waiting' };
  const links = {};
  const push = (patch = {}) => update({ steps: { ...steps }, links: { ...links }, ...patch });
  push();

  try {
    // 1. Commit: the site, plus the workflow and tests if the repo doesn't have them yet (one commit, one CI run).
    const { commit, html_url } = await commitSite(repo, branch, path, html, commitMessage);
    steps.commit = 'done';
    links.commit = html_url;
    steps.test = 'running';
    push();

    // 2. Follow the Actions run for this commit (jobs named "test" and "deploy").
    const deadline = Date.now() + 6 * 60_000;
    let run;
    while (Date.now() < deadline) {
      await sleep(4000);
      run = (await gh('GET', `/repos/${repo}/actions/runs?head_sha=${commit}&per_page=1`)).workflow_runs?.[0];
      if (!run) continue;
      links.run = run.html_url;
      const { jobs = [] } = await gh('GET', `/repos/${repo}/actions/runs/${run.id}/jobs`);
      for (const job of jobs) {
        const key = /deploy/i.test(job.name) ? 'deploy' : /test/i.test(job.name) ? 'test' : null;
        if (!key) continue;
        steps[key] = job.status !== 'completed' ? 'running' : job.conclusion === 'success' ? 'done' : job.conclusion === 'skipped' ? 'skipped' : 'failed';
        if (steps[key] === 'failed') {
          const step = job.steps?.find((s) => s.conclusion === 'failure');
          links[`${key}Failure`] = step?.name || job.name;
        }
      }
      push();
      if (run.status === 'completed') break;
    }
    if (!run || run.status !== 'completed') throw new Error('CI is taking longer than 6 minutes. Check the Actions tab.');
    if (run.conclusion !== 'success') {
      const why = links.testFailure ? `Tests failed at "${links.testFailure}".` : links.deployFailure ? `Deploy failed at "${links.deployFailure}".` : `CI finished with "${run.conclusion}".`;
      push({ failed: true, done: true, summary: `Shipping failed. ${why} Nothing was deployed.` });
      return;
    }

    // 3. Confirm the site answers.
    steps.live = 'running';
    push();
    let url;
    try {
      url = (await gh('GET', `/repos/${repo}/pages`)).html_url;
    } catch {
      const [owner, name] = repo.split('/');
      url = `https://${owner.toLowerCase()}.github.io/${name}/`;
    }
    for (let i = 0; i < 15; i++) {
      const res = await fetch(url, { cache: 'no-store' }).catch(() => null);
      if (res?.ok) break;
      await sleep(3000);
    }
    steps.live = 'done';
    push({ url, done: true, summary: `Shipped. Tests passed and the site is live at ${url}` });
  } catch (err) {
    for (const k of Object.keys(steps)) if (steps[k] === 'running') steps[k] = 'failed';
    push({ failed: true, done: true, summary: `Shipping failed: ${explain(err)}` });
  }
}
