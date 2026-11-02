# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via **GitHub → Security → Report a vulnerability** (private vulnerability reporting) rather than opening a public issue. Include steps to reproduce and the affected version/commit. You should receive an acknowledgement within a few days.

## Scope notes

* The backend is designed to listen on `127.0.0.1` only. Exposing it on a network interface is unsupported.
* Meeting data (`backend/eloquent_coach.db`, `backend/transcripts/`) is stored locally and is git-ignored. Never commit it.
* Dependencies are monitored by Dependabot and audited in CI (`pip-audit`, `npm audit`, dependency review). See *Keeping dependencies up to date* in the README.
