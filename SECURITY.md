# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Instead, use [GitHub's private vulnerability reporting](https://github.com/KoroKira/alcove/security/advisories/new) ("Report a vulnerability" on the Security tab). You should get a first response within a week.

## Scope & deployment model

Alcove is designed for **local, single-user use on your own machine**. If you expose it on a network or the internet, you must at minimum:

- Change every default password in `.env` (`admin123`, `redis123`, …).
- Keep the embedded local terminal (ttyd) bound to localhost only — it is a real shell on the host machine.
- Put the app behind HTTPS and authentication (Keycloak is included in the Docker setup).

Issues that only occur when these deployment rules are ignored are configuration problems, not vulnerabilities — but reports about unsafe defaults are always welcome.
