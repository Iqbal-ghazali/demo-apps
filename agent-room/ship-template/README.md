# Agent Room ship target

What Agent Room's optional **Ship** puts in your repo. The room commits the newest website to
`site/index.html`; GitHub Actions then runs `tests/check.mjs` and, only if every check passes,
deploys `site/` to GitHub Pages. On the first ship, the room also adds `.github/workflows/deploy.yml`
and `tests/check.mjs` from this folder (same commit), so the repo can start empty.

## Set up (once, about 2 minutes)

1. Create a **public** GitHub repo (e.g. `portfolio-site`). Ticking "Add a README" is fine.
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Create a **fine-grained personal access token** (GitHub → Settings → Developer settings):
   - Repository access: **only** this repo
   - Permissions: **Contents: Read and write**, **Workflows: Read and write** (to add the workflow on the
     first ship), **Actions: Read-only**, **Pages: Read-only**
   - A short expiry (e.g. 7 days)
4. Add to Agent Room's `.env` (paste directly into the file, never into a chat):
   ```
   GITHUB_TOKEN=github_pat_...
   GITHUB_REPO=your-name/agent-room-site
   ```
5. Restart Agent Room. The **Ship** button in the preview panel turns on, and you can ask for a ship in the chat.

The token stays on the room's server. The agents never see it and can't trigger a deploy on their own:
only a person pressing **Ship**, or asking for it in the chat, does.
