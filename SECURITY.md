# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Instead, use [GitHub's private vulnerability reporting](https://github.com/KoroKira/alcove/security/advisories/new) ("Report a vulnerability" on the Security tab). You should get a first response within a week.

## Scope & deployment model

Alcove is designed for **local, single-user use on your own machine**. If you expose it on a network or the internet, you must at minimum:

- Change every default password in `.env` (`admin123`, `redis123`, …).
- Leave the embedded local terminal disabled (the default: `TTYD_URL` empty). Alcove no longer starts or installs `ttyd`. If you run one yourself, it is a real shell on the host machine: it must require authentication and must not be reachable from a web page you visit.
- Put the app behind HTTPS and authentication (Keycloak is included in the Docker setup).

Issues that only occur when these deployment rules are ignored are configuration problems, not vulnerabilities — but reports about unsafe defaults are always welcome.

## Embedded local terminal

Earlier versions of `scripts/run.sh` started `ttyd` automatically. This is no longer done. If you used it, stop any `ttyd` process still running on port 7681 (`lsof -i :7681`; `brew services list | grep ttyd`) and do not expose that port. A secure re-introduction (authenticated, same-origin) is planned.
