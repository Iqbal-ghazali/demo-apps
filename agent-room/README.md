# Agent Room

One shared conversation where you brainstorm with **Claude** and **Codex** at the same time.
Both agents read the same transcript, so each reply can respond to what the other just said, and
anything you add (a follow-up, a changed requirement) shapes the next replies.

It runs locally and calls the real Claude Code and Codex CLIs with your own accounts.

- [Quick start (Docker)](#quick-start-docker): recommended, same setup on macOS, Windows and Linux
- [Run without Docker](#run-without-docker)
- [Using the room](#using-the-room)
- [Configuration](#configuration) · [Troubleshooting](#troubleshooting) · [Security](#security)

What works, what's limited and why it's built this way: [NOTES.md](NOTES.md).

## What you need

| | Option A: subscription (no extra cost) | Option B: API key (pay per use) |
|---|---|---|
| **Claude** | Claude Pro or Max, plus a token from `claude setup-token` | Anthropic API key with credit |
| **Codex** | A ChatGPT account signed in to Codex | OpenAI API key with credit |

ChatGPT and Claude subscriptions are separate from API billing. You only need one option per agent,
and you can mix them. Option B is supported but was not tested for this demo (see NOTES.md).

## Quick start (Docker)

Requires Docker Desktop (or Docker Engine with Compose v2.24+). Works on Intel/AMD and Apple Silicon.

**1. Add your Claude credential**

```bash
cp .env.example .env
```

Then fill in **one** of these in `.env`:

- `CLAUDE_CODE_OAUTH_TOKEN`: run `claude setup-token` on any machine with Claude Code installed and paste the token
- `ANTHROPIC_API_KEY`: an API key from the Anthropic Console

**2. Sign in to Codex (once)**

Pick one. The sign-in is stored in a Docker volume (`agent-room_codex-home`) and survives restarts.

- **Reuse the Codex sign-in already on your computer** (fastest, tested):

  macOS / Linux:
  ```bash
  docker compose run --rm -v "$HOME/.codex/auth.json:/mnt/auth.json:ro" agent-room \
    sh -c 'cp /mnt/auth.json "$CODEX_HOME/auth.json" && chmod 600 "$CODEX_HOME/auth.json" && codex login status'
  ```
  Windows (PowerShell):
  ```powershell
  docker compose run --rm -v "$env:USERPROFILE\.codex\auth.json:/mnt/auth.json:ro" agent-room sh -c 'cp /mnt/auth.json "$CODEX_HOME/auth.json" && chmod 600 "$CODEX_HOME/auth.json" && codex login status'
  ```
  No `auth.json` there? Your Codex keeps its sign-in in the OS keychain; use the next option.
- **Sign in from inside the container** with a device code:
  ```bash
  docker compose run --rm agent-room codex login --device-auth
  ```
- **API key:** set `OPENAI_API_KEY` in `.env`; the container signs Codex in with it on start.

**3. Start the room**

Use the prebuilt image (Intel/AMD and Apple Silicon):

```bash
AGENT_ROOM_IMAGE=iqbal508/agent-room:0.1.0 docker compose up -d --no-build
```

Or build it yourself from this source:

```bash
docker compose up -d --build
```

(To use the prebuilt image for step 2 too, put `AGENT_ROOM_IMAGE=iqbal508/agent-room:0.1.0` in `.env`
first. On Windows PowerShell, set it with `$env:AGENT_ROOM_IMAGE="iqbal508/agent-room:0.1.0"`.)

Open **http://localhost:3000**. On start, the room checks both agents with one tiny real call; the
sidebar shows each connection, and anything that isn't connected comes with the exact fix.

Port 3000 taken? Run `AGENT_ROOM_PORT=3300 docker compose up --build` and open http://localhost:3300.

## Run without Docker

Requires Node.js 22.9+ and both CLIs:

```bash
npm install -g @anthropic-ai/claude-code @openai/codex
claude setup-token   # paste the token into .env as CLAUDE_CODE_OAUTH_TOKEN
codex login
npm install          # three small browser libraries (see NOTES.md)
npm start
```

`npm run check` tests both connections in the terminal without starting the server.

## Using the room

1. Type what you want to brainstorm and send it. That starts a new room in the sidebar.
2. Claude replies first, then Codex replies with Claude's message in view. Each reply shows which message it answers.
3. Change the plan at any time ("actually, no bank account"). Your latest message overrides earlier requirements.
4. **Continue** runs one more Claude → Codex exchange without you typing.
5. Start a message with **@claude** or **@codex** to ask just one of them.
6. The send button turns into **Stop** while an agent is replying. If an agent fails, its message shows why, with **Retry**.
7. Rooms are saved: switch between them in the sidebar, start a fresh one with **New room**, delete with the trash icon.
8. The download icon exports the conversation as Markdown.

Each agent has a role so the conversation has some friction: Claude is the **builder** (turns ideas
into a concrete plan), Codex is the **skeptic** (finds the weak spot and cuts scope). Disagreement
isn't scripted; both are simply told to engage with each other's points and not agree just to be polite.

## Configuration

Set these in `.env`.

| Variable | Default | What it does |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | | Claude subscription token from `claude setup-token` |
| `ANTHROPIC_API_KEY` | | Claude API key (used instead of the token if set) |
| `OPENAI_API_KEY` | | Codex API key (Docker signs in with it on start) |
| `CLAUDE_MODEL` | CLI default | e.g. `sonnet` or `opus` |
| `CODEX_MODEL` | account default | Any model your Codex account can use |
| `AGENT_TIMEOUT_SECONDS` | `150` | Give up on a reply after this long |
| `SKIP_PING` | | `1` = start-screen check only confirms the CLIs exist (no real call) |
| `AGENT_ROOM_PORT` | `3000` | Host port for Docker |
| `DATA_DIR` | `./data` | Where rooms and logs are saved (Docker: the `agent-room_data` volume) |

## Troubleshooting

| You see | Fix |
|---|---|
| `Claude isn't signed in` | Check `CLAUDE_CODE_OAUTH_TOKEN` in `.env` (tokens can expire: run `claude setup-token` again), then restart. |
| `Codex isn't signed in` | Redo step 2, then click **Re-check**. |
| `hit a usage or rate limit` | Your plan's limit was reached. Wait for it to reset, then **Retry**. |
| `didn't reply within 150s` | Click **Retry**, or raise `AGENT_TIMEOUT_SECONDS`. |
| `port is already allocated` | Use `AGENT_ROOM_PORT=3300`. |
| Nothing loads | `docker compose logs` shows the startup connection check. |

## Security

- **Credentials are only read at runtime** from `.env` or the Codex volume. They are never copied into
  the image (`.env` is in `.dockerignore`) and never shown in the UI.
- **Agents can't touch your machine.** Claude runs with all tools disabled; Codex runs in a read-only
  sandbox. Both work in an empty scratch folder and ignore your personal CLI settings, hooks and plugins.
- **Local only.** The port is bound to `127.0.0.1`. The server also rejects requests from other hosts
  (DNS rebinding) and cross-site posts.
- **Hardened container:** non-root user, read-only filesystem, all Linux capabilities dropped,
  `no-new-privileges`.
- **Agent output is sanitized.** Replies are rendered as Markdown and cleaned with DOMPurify before
  they reach the page; a strict Content-Security-Policy blocks inline and third-party scripts.
- **Data:** rooms are saved to `data/rooms/` and every agent call (prompt, reply, timing, exit code)
  to `data/logs/` (Docker: the `agent-room_data` volume). They contain your conversations, never credentials.
