# Contributing

Merci de l'intérêt ! / Thanks for your interest! Issues and PRs are welcome in French or English.

## Getting started

See [SETUP.md](SETUP.md) for the full development setup. The short version (macOS):

```bash
bash scripts/run.sh          # installs deps via Homebrew and starts everything
```

## Before opening a PR

1. **Run the backend tests**:
   ```bash
   cd src/backend
   pip install -r requirements.txt -r requirements-dev.txt
   python -m pytest tests/
   ```
2. **Make sure the frontend builds**:
   ```bash
   cd src/frontend && yarn && yarn build
   ```
3. Keep PRs focused — one feature or fix per PR.
4. No hardcoded colors in the frontend: use the `--ap-*` CSS design tokens.
5. Database schema changes go through an Alembic migration (see `src/backend/MIGRATIONS.md`).

## Reporting bugs

Open an issue with: what you did, what you expected, what happened instead, and your setup (macOS local mode or Docker).

## Security issues

See [SECURITY.md](SECURITY.md) — please report privately, not in a public issue.
