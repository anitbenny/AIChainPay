# GitHub submission checklist

Current preparation: a read-only CI workflow is included at [.github/workflows/ci.yml](../.github/workflows/ci.yml), using Node 22 and the official checkout/setup-node v7 examples ([checkout](https://github.com/actions/checkout), [setup-node](https://github.com/actions/setup-node), checked 2026-10-19). It runs build, contract/backend tests and the secret-pattern scan with no deployment keys. It has **not run on GitHub**. Local build/tests passed. No remote exists and GitHub CLI is unavailable; publication still requires the user's account, destination and visibility choice. Existing unrelated work was not committed or staged by this completion pass.

The new [confirmation-card screenshot](./screenshots/confirmation-card-local-test.png) is a synthetic-host browser render, not proof of actual ChatGPT approval. Follow the current [client guide](./client-integration.md), not archived native-probe instructions. Do not upload the private agent key, confirmation capability hashes/database, OAuth objects or environment files.

Reproducibility checked 2026-10-20: a fresh source-only temporary copy, without private environments/keys/databases, passed `npm.cmd ci --no-audit --no-fund`, `npm.cmd run build` and `npm.cmd test` (9 contract + 12 backend tests). This is local clean-install evidence, not a GitHub CI run.

The repository is local only: no GitHub remote or publication is claimed. Do not upload an ignored database, environment file, wallet key, OAuth signing JWK, raw signed transaction, or tunnel authtoken. The local-chain screenshot is a real rendered dashboard using an injected test provider. A second real screenshot shows the deployed Sepolia contract through a read-only connector with **no wallet connected**. Neither is evidence of a real MetaMask Sepolia signature; capture that separately after manual testing.

Before publication, from PowerShell in the workspace:

```powershell
git status --short
git diff --check
npm.cmd run check:git-safety
git remote
git ls-files
```

Review the exact staged changes with `git diff --cached --stat` and `git diff --cached` before committing. Treat screenshots and logs as potentially sensitive. The automated check prints only finding categories and filenames; it cannot detect every kind of secret. The repository's `.gitignore` excludes `.env` files, SQLite, keys, build output and raw signed transactions; do not force-add them. Check `git status --short --ignored` locally for accidental secret files, but do not paste their contents into chat. After the user supplies authorized GitHub access and chooses a repository name/visibility, create the remote, push and record its **actual** URL. Do not present a local commit as GitHub publication.

The README/status include the Sepolia address, deployment block, explorer links, a real **unconnected** Sepolia dashboard screenshot, genuine owner setup transactions, the confirmed ChatGPT-initiated vault payment, and later revoke/regrant receipts. The user-supplied ChatGPT card screenshot is verification-only; the separate live transfer is proven by its card-decision audit, on-chain receipt/event/recipient delta and authenticated status response, not by that screenshot. If a connected MetaMask or live-card screenshot is required, capture it from the real session and label it accurately; never fabricate one. GitHub publication remains outstanding.
