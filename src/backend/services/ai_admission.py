"""Distributed admission control for expensive AI inference.

Redis is used deliberately: limits remain effective with several API workers and
after moving inference behind a shared server. Counters have leases so a killed
worker cannot permanently consume a slot.
"""
import asyncio
import os
import secrets
from contextlib import asynccontextmanager
from dataclasses import dataclass
from uuid import UUID

from fastapi import HTTPException

from cache import RedisClient


AI_RATE_PER_MINUTE = int(os.getenv("AI_RATE_PER_MINUTE", "12"))
AI_DAILY_QUOTA = int(os.getenv("AI_DAILY_QUOTA", "200"))
AI_GLOBAL_CONCURRENCY = int(os.getenv("AI_GLOBAL_CONCURRENCY", "2"))
AI_USER_CONCURRENCY = int(os.getenv("AI_USER_CONCURRENCY", "1"))
AI_QUEUE_TIMEOUT_SECONDS = float(os.getenv("AI_QUEUE_TIMEOUT_SECONDS", "20"))
AI_LEASE_SECONDS = int(os.getenv("AI_LEASE_SECONDS", "360"))

_ACQUIRE = """
local now = redis.call('TIME')[1]
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], now + ARGV[3], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
"""


async def _increment_window(key: str, limit: int, ttl: int) -> None:
    redis = await RedisClient.get_instance()
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incr(key)
        pipe.expire(key, ttl, nx=True)
        count, _ = await pipe.execute()
    if int(count) > limit:
        retry = await redis.ttl(key)
        raise HTTPException(
            status_code=429,
            detail="Limite d'utilisation IA atteinte. Réessayez plus tard.",
            headers={"Retry-After": str(max(1, retry))},
        )


async def charge_user(user_id: UUID) -> None:
    """Charge one generation against the short and daily user budgets."""
    await _increment_window(f"ai:rate:{user_id}", AI_RATE_PER_MINUTE, 60)
    await _increment_window(f"ai:quota:{user_id}", AI_DAILY_QUOTA, 86400)


@dataclass
class _Lease:
    global_key: str
    user_key: str
    token: str


async def _try_acquire(user_id: UUID) -> _Lease | None:
    redis = await RedisClient.get_instance()
    token = secrets.token_urlsafe(18)
    global_key = "ai:slots:global"
    user_key = f"ai:slots:user:{user_id}"
    got_global = await redis.eval(
        _ACQUIRE, 1, global_key, AI_GLOBAL_CONCURRENCY, token, AI_LEASE_SECONDS,
    )
    if not got_global:
        return None
    got_user = await redis.eval(
        _ACQUIRE, 1, user_key, AI_USER_CONCURRENCY, token, AI_LEASE_SECONDS,
    )
    if not got_user:
        await redis.zrem(global_key, token)
        return None
    return _Lease(global_key, user_key, token)


async def _release(lease: _Lease) -> None:
    redis = await RedisClient.get_instance()
    async with redis.pipeline(transaction=True) as pipe:
        pipe.zrem(lease.global_key, lease.token)
        pipe.zrem(lease.user_key, lease.token)
        await pipe.execute()


@asynccontextmanager
async def inference_slot(user_id: UUID):
    """Wait briefly for a fair-enough shared slot, then always release it."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + AI_QUEUE_TIMEOUT_SECONDS
    lease = None
    while loop.time() < deadline:
        lease = await _try_acquire(user_id)
        if lease:
            break
        await asyncio.sleep(0.25)
    if lease is None:
        raise HTTPException(
            status_code=503,
            detail="Le moteur IA est occupé. Réessayez dans quelques instants.",
            headers={"Retry-After": "5"},
        )
    try:
        yield
    finally:
        await _release(lease)
