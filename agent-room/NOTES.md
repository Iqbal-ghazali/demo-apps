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

**Optional extra (beyond the brief): build and ship.** Ask for a website and Claude writes it as one
self-contained HTML file, Codex reviews it, and the site runs in a sandboxed preview next to the chat.
With a GitHub repo set up, **Ship** (the button, or asking in the chat) commits it; GitHub Actions runs
quality checks and deploys to GitHub Pages only if they pass. The repo can start empty. Tested end to end: a buggy first version was blocked by the checks
("Nothing was deployed"), the fixed version went live in about 40 seconds.

## Limitations (honest list)

- **Prototype, local only.** One user, no accounts, not deployed.
- **Fixed turn order.** Claude speaks first, then Codex, then the room waits for you. Agents don't decide on their own when to speak.
- **No streaming.** A reply appears when it's complete. Typical wait in testing: Claude 4–20s, Codex 4–15s.
- **Stateless turns.** The full transcript is sent on every turn (last 40 messages), so very long conversations get slower and use more of your plan.
- **A reply in progress is lost if the server stops.** The room is saved; that message shows "Interrupted" with Retry.
- **Disagreement isn't guaranteed.** The roles (builder vs skeptic) and instructions encourage real pushback, but if both agents agree, the room shows that.
- **Agents can still be wrong.** They're told not to invent numbers or facts, but the room doesn't fact-check them.
- **Codex model depends on your plan.** Testing used a free ChatGPT account, which ran `gpt-6-luna`. Paid plans may get stronger models (set `CODEX_MODEL`).
- **Build mode is for small, single-file sites.** No frameworks, packages, images from the web or backends. Longer files make replies slower (Claude took 17–32s for 110–200 lines).
- **The CI checks are basic** (structure, viewport, self-contained, alt text, no `href="#"`). In testing, Codex still caught problems the checks missed (placeholder URLs, an unimplemented feature the copy promised, `innerHTML` for user-editable text). The human decides when to ship.
- **Claude Code tells Claude your account email.** The CLI adds the signed-in account's email to every call, and
  in testing Claude once put it into a generated site. Claude is told to ignore account details, and the room
  replaces any email address an agent writes that you didn't type yourself with `you@example.com`.
- **Codex can keep finding things.** In testing it said "Ready to ship." after 1–3 fix rounds. You decide when it's good enough.
- **API-key mode is untested.** The code supports `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, but all testing used subscription sign-ins.
- **Image size: about 820 MB on disk, ~290 MB to download.** Almost all of it is the two CLIs (Claude Code ~300 MB, Codex ~300 MB), which the room needs. Codex's unused voice and "code mode" helpers and npm are left out of the image.

## Main decisions

1. **Local web app, not a chat-platform bot.** A Telegram/Discord bot can't see other bots' messages, and the UI couldn't show who is replying to whom. A local page keeps setup to one command and puts the shared conversation on screen.
2. **Real CLIs, not raw model APIs.** The brief asks for Claude and Codex, so the room drives the actual Claude Code and Codex CLIs rather than a generic model labeled "Codex".
3. **One transcript, one speaker at a time.** Agents take turns over the same transcript, so each reply is written with the previous one in view. That's what makes real back-and-forth possible.
4. **Builder vs skeptic roles.** Two agents with the same instructions tend to agree. Different jobs (make it concrete / cut it down) produce useful friction without scripting outcomes.
5. **Agents locked down.** Claude runs with all tools disabled; Codex runs in a read-only sandbox. Both work in an empty folder and ignore the user's own CLI settings, hooks and plugins. This also cut Claude's reply time from ~12s to ~5s in testing.
6. **Subscription sign-in first, API keys optional.** Most people who'd try this already pay for Claude and ChatGPT. Credentials are only read at runtime and never copied into the image.
7. **Agents write, a person ships.** The room server holds the GitHub token (fine-grained, one repo). Agents never see it and can't trigger a deploy: the room ships only when you press Ship, or when your own latest message asks for it and Claude confirms. Generated sites run in a preview served with `CSP: sandbox allow-scripts` and no network, so they can't reach the room's API.
8. **Three checks before anything goes live:** Codex's review, the person's decision, and CI checks that block the deploy if they fail.
9. **Small, boring stack.** The server uses only Node built-ins. The page uses three small browser libraries with no build step. Docker pins the CLI versions (Claude Code 2.1.229, Codex 0.165.0), builds for Intel and Apple Silicon, and runs hardened.

## Open-source libraries

| Library | Version | License | Used for |
|---|---|---|---|
| [Preact](https://preactjs.com) + [htm](https://github.com/developit/htm) | htm 3.1.1 (`htm/preact/standalone`, bundles Preact) | MIT / Apache-2.0 | Rendering the UI without a build step |
| [marked](https://marked.js.org) | 18.1.2 | MIT | Turning agent replies (Markdown) into HTML |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.17 | MPL-2.0 or Apache-2.0 | Sanitizing that HTML before it reaches the page |
| [Lucide](https://lucide.dev) (`lucide-static`) | 1.62.0 | ISC | Icons. Dev-only: `npm run icons` copies the 20 icons used into `public/icons.svg` |

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
| Build: Claude writes a site, Codex reviews, fixes, preview updates (Windows, no Docker) | Works (2 rooms) |
| Ship a version that fails the checks | Commit ✓, tests ✗, deploy skipped, "Nothing was deployed" |
| Ship a fixed version | Commit ✓, tests ✓, deploy ✓, live in ~40s |
| Ship by asking in the chat ("Push it to GitHub and make it live") | Claude confirms, room ships, live |
| Agent writes an email address you never typed | Replaced with `you@example.com` |
| Build + review inside Docker (hardened compose, 0.2.0) | Works; Codex said "ready to ship" after 3 fix rounds |
| Ship from inside Docker | GitHub API reachable and ship config read from the container; the full ship was tested without Docker |
| Stop, Retry, timeout and signed-out errors | Clear messages, no hang |
| Requests from another host / cross-site requests | Rejected (403) |
| Secret scan of the image and logs | No credentials found |
| API-key mode | Not tested |
