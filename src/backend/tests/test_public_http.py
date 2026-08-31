import asyncio
import socket

import pytest
from fastapi import HTTPException

from services.public_http import validate_public_url


@pytest.mark.parametrize("url", [
    "http://127.0.0.1/admin",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "ftp://example.com/file",
    "http://user:password@example.com/",
])
def test_rejects_non_public_urls(url):
    with pytest.raises(HTTPException):
        asyncio.run(validate_public_url(url))


def test_rejects_hostname_resolving_to_private_address(monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.4", 80))],
    )
    with pytest.raises(HTTPException):
        asyncio.run(validate_public_url("http://internal.example/resource"))
