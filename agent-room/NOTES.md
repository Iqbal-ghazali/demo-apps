# Agent Room: what works, what's limited, and why

## What works

| Requirement | How the room does it | Where you can see it |
|---|---|---|
| Real responses, not scripted | Every reply is a live call to the Claude Code CLI or the Codex CLI. | Model name under each reply; full prompt and raw output for every call in `data/logs/` |
| Clear who said what | Your messages on the right; Claude and Codex on the left, each with its own name, color and avatar. | Chat view |
| Agents respond to each other | Both agents read the same transcript and are told to engage with a specific point the other made. Each reply quotes the message it answers. | The quote above each agent reply |
| You can steer mid-conversation | Your message joins the transcript, and the latest human message is defined as the current requirement. | Change a requirement; both agents rework the plan |
| No copy-pasting between windows | The server runs the turns: you → Claude → Codex. **Continue** runs another exchange; `@claude` / `@codex` asks just one. | One page, one conversation |

Also: saved rooms with a sidebar (new, switch, delete), connection status with a fix-it hint, Stop,
Retry on failed turns, Markdown export, light and dark themes.

## Limitations (honest list)

- **Prototype, local only.** One user, no accounts, not deployed.
- **Fixed turn order.** Claude speaks first, then Codex, then the room waits for you. Agents don't decide on their own when to speak.
- **No streaming.** A reply appears when it's complete. Typical wait in testing: Claude 4–20s, Codex 4–15s.
- **Stateless turns.** The full transcript is sent on every turn (last 40 messages), so very long conversations get slower and use more of your plan.
- **A reply in progress is lost if the server stops.** The room is saved; that message shows "Interrupted" with Retry.
- **Disagreement isn't guaranteed.** The roles (builder vs skeptic) and instructions encourage real pushback, but if both agents agree, the room shows that.
- **Agents can still be wrong.** They're told not to invent numbers or facts, but the room doesn't fact-check them.
- **Codex model depends on your plan.** Testing used a free ChatGPT account, which ran `gpt-6-luna`. Paid plans may get stronger models (set `CODEX_MODEL`).
- **API-key mode is untested.** The code supports `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, but all testing used subscription sign-ins.
- **Image size: about 820 MB on disk, ~290 MB to download.** Almost all of it is the two CLIs (Claude Code ~300 MB, Codex ~300 MB), which the room needs. Codex's unused voice and "code mode" helpers and npm are left out of the image.

## Main decisions

1. **Local web app, not a chat-platform bot.** A Telegram/Discord bot can't see other bots' messages, and the UI couldn't show who is replying to whom. A local page keeps setup to one command and puts the shared conversation on screen.
2. **Real CLIs, not raw model APIs.** The brief asks for Claude and Codex, so the room drives the actual Claude Code and Codex CLIs rather than a generic model labeled "Codex".
3. **One transcript, one speaker at a time.** Agents take turns over the same transcript, so each reply is written with the previous one in view. That's what makes real back-and-forth possible.
4. **Builder vs skeptic roles.** Two agents with the same instructions tend to agree. Different jobs (make it concrete / cut it down) produce useful friction without scripting outcomes.
5. **Agents locked down.** Claude runs with all tools disabled; Codex runs in a read-only sandbox. Both work in an empty folder and ignore the user's own CLI settings, hooks and plugins. This also cut Claude's reply time from ~12s to ~5s in testing.
6. **Subscription sign-in first, API keys optional.** Most people who'd try this already pay for Claude and ChatGPT. Credentials are only read at runtime and never copied into the image.
7. **Small, boring stack.** The server uses only Node built-ins. The page uses three small browser libraries with no build step. Docker pins the CLI versions (Claude Code 2.1.229, Codex 0.165.0), builds for Intel and Apple Silicon, and runs hardened.

## Open-source libraries

| Library | Version | License | Used for |
|---|---|---|---|
| [Preact](https://preactjs.com) + [htm](https://github.com/developit/htm) | htm 3.1.1 (`htm/preact/standalone`, bundles Preact) | MIT / Apache-2.0 | Rendering the UI without a build step |
| [marked](https://marked.js.org) | 18.1.2 | MIT | Turning agent replies (Markdown) into HTML |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.17 | MPL-2.0 or Apache-2.0 | Sanitizing that HTML before it reaches the page |
| [Lucide](https://lucide.dev) (`lucide-static`) | 1.62.0 | ISC | Icons. Dev-only: `npm run icons` copies the 12 icons used into `public/icons.svg` |

Versions are pinned in `package.json` and `package-lock.json`. Libraries are served from the app
itself (no CDN), so the page works offline and the Content-Security-Policy can stay `'self'`.

## How it was tested

| Check | Result |
|---|---|
| Codex on a free ChatGPT account via `codex exec` | Works (`gpt-6-luna`) |
| Claude via `claude setup-token` token | Works (`claude-sonnet-5`) |
| Full conversation incl. requirement change + Continue, Windows, no Docker | Works |
| Rooms saved across a server restart; delete; export | Works |
| Same in Docker (linux/amd64), hardened compose, rooms saved across a container restart | Works |
| Docker linux/arm64 (Apple Silicon) under emulation | Both agents connect (real call). Not tried on a physical Mac. |
| Stop, Retry, timeout and signed-out errors | Clear messages, no hang |
| Requests from another host / cross-site requests | Rejected (403) |
| Secret scan of the image and logs | No credentials found |
| API-key mode | Not tested |
