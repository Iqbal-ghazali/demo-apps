# Changelog

## 0.2.0

- **Build mode:** ask for a website; Claude writes it as one HTML file, Codex reviews the newest version,
  and the site runs in a sandboxed Preview panel next to the chat.
- **Ship to GitHub Pages:** the Ship button, or ask in the chat ("Push it to GitHub and make it live").
  The room commits the site, follows the GitHub Actions run (tests → deploy) and shows the live link.
  The repo can start empty: the first ship adds the test and deploy workflow (`ship-template/`).
- **Codex can sign off:** it lists only launch-day problems and says "Ready to ship." when none are left.
- **Privacy guard:** an email address an agent writes that you never typed is replaced with
  `you@example.com` (Claude Code passes the signed-in account's email to every call).
- Docker image now includes `ship-template/`.

## 0.1.0

- One shared conversation with Claude and Codex: speaker labels, replies that quote what they answer,
  Continue / @mentions, Stop / Retry, saved rooms, Markdown export, light and dark themes. Docker image for
  Intel/AMD and Apple Silicon.
