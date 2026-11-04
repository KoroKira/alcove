"""Host-header allowlist for the unauthenticated PAD_DEV_MODE.

Dev mode logs every visitor in as the local user, so the only thing standing
between a web page and the user's notes is that the request reaches the
loopback interface at all. A page on another domain can make the browser
resolve its own name to 127.0.0.1 (DNS rebinding) and then speak to the app as
a same-origin site; the Host header it sends is the attacker's name. Refusing
unknown Host values closes that path without affecting normal use.
"""
from __future__ import annotations

import ipaddress
from typing import Iterable, Optional
from urllib.parse import urlsplit

LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def normalize_host(value: Optional[str]) -> str:
    """Return the lower-cased hostname of a Host header or URL, without port."""
    value = (value or "").strip().lower()
    if not value:
        return ""
    if "//" in value:
        value = urlsplit(value).netloc
    if value.startswith("["):                       # [::1]:8000
        return value[1:].split("]", 1)[0]
    if value.count(":") == 1:                       # host:port
        return value.split(":", 1)[0]
    return value                                    # bare host or bare IPv6


def build_allowed_hosts(extra_urls: Iterable[Optional[str]], extra_hosts: str = "") -> frozenset[str]:
    hosts = set(LOOPBACK_HOSTS)
    for url in extra_urls:
        host = normalize_host(url)
        if host:
            hosts.add(host)
    for item in (extra_hosts or "").split(","):
        host = normalize_host(item)
        if host:
            hosts.add(host)
    return frozenset(hosts)


def host_allowed(host_header: Optional[str], allowed: frozenset[str]) -> bool:
    host = normalize_host(host_header)
    if not host:
        return False
    if host in allowed:
        return True
    try:                                            # 127.0.0.2, ::ffff:127.0.0.1 ...
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class DevHostGuard:
    """Pure ASGI middleware: answer 400 to HTTP and close WebSockets on a bad Host."""

    def __init__(self, app, allowed: frozenset[str]):
        self.app = app
        self.allowed = allowed

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            host = next((v.decode("latin-1") for k, v in scope.get("headers", []) if k == b"host"), None)
            if not host_allowed(host, self.allowed):
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                else:
                    body = b"Invalid Host header"
                    await send({"type": "http.response.start", "status": 400,
                                "headers": [(b"content-type", b"text/plain"), (b"content-length", str(len(body)).encode())]})
                    await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)
