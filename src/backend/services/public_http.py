"""HTTP helpers for user-supplied public URLs.

Every redirect target is resolved before connecting, preventing authenticated
users from turning ingestion endpoints into a proxy to loopback, Docker, cloud
metadata, or the private LAN.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urljoin, urlsplit

import httpx
from fastapi import HTTPException


async def validate_public_url(url: str) -> None:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(400, "URL publique http/https attendue")
    if parsed.username or parsed.password:
        raise HTTPException(400, "Les identifiants intégrés à l'URL sont interdits")

    try:
        addresses = await asyncio.get_running_loop().run_in_executor(
            None,
            lambda: socket.getaddrinfo(parsed.hostname, parsed.port, type=socket.SOCK_STREAM),
        )
    except socket.gaierror as exc:
        raise HTTPException(400, "Nom d'hôte introuvable") from exc

    for entry in addresses:
        address = ipaddress.ip_address(entry[4][0])
        if not address.is_global:
            raise HTTPException(400, "Les adresses réseau privées ou locales sont interdites")


async def get_public_url(
    url: str,
    *,
    timeout: float = 15,
    headers: dict[str, str] | None = None,
    params: dict | None = None,
    max_redirects: int = 5,
) -> httpx.Response:
    """GET a public URL, validating DNS again before every redirect hop."""
    current = url
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        for hop in range(max_redirects + 1):
            await validate_public_url(current)
            response = await client.get(current, headers=headers, params=params if hop == 0 else None)
            if response.is_redirect:
                location = response.headers.get("location")
                if not location or hop == max_redirects:
                    raise HTTPException(502, "Trop de redirections HTTP")
                current = urljoin(str(response.url), location)
                continue
            return response
    raise HTTPException(502, "Redirection HTTP invalide")
