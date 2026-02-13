# Agent Instructions

## Commit and Deploy

After making changes, always:

1. **Commit** — `git add -A && git commit -m "descriptive message"`
2. **Push** — `git push origin main`
3. **Deploy** — `pnpm deploy` (runs migrations first, then deploys all packages)

Or deploy specific packages:

- `pnpm --filter @trel/frontend run deploy`
- `pnpm --filter @trel/docs run deploy`
- `pnpm --filter @trel/marketing run deploy`
- `pnpm --filter @trel/api run deploy`

Don't leave changes uncommitted or undeployed.
