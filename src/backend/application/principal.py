"""Authentication-neutral principal shared by browser and API clients."""

from dataclasses import dataclass, field
from typing import Any, FrozenSet, Iterable, Optional
from uuid import UUID


ALL_EXTERNAL_SCOPES: FrozenSet[str] = frozenset({
    "me:read",
    "pads:read",
    "pads:write",
    "pads:share",
    "search:read",
})


@dataclass(frozen=True)
class Principal:
    """Identity used by application services and authorization decisions."""

    id: UUID
    auth_type: str = "session"  # session | api_token
    scopes: FrozenSet[str] = field(default_factory=frozenset)
    token_id: Optional[UUID] = None
    username: str = ""
    email: str = ""
    email_verified: bool = False
    name: str = ""
    given_name: str = ""
    family_name: str = ""
    roles: tuple[str, ...] = ()

    @property
    def is_api_token(self) -> bool:
        return self.auth_type == "api_token"

    @property
    def is_session(self) -> bool:
        return self.auth_type == "session"

    @property
    def is_admin(self) -> bool:
        return "admin" in self.roles

    def has_scope(self, scope: str) -> bool:
        # Existing browser sessions retain their current behavior. API tokens
        # must opt into every capability explicitly.
        return self.is_session or scope in self.scopes

    def has_all_scopes(self, scopes: Iterable[str]) -> bool:
        return all(self.has_scope(scope) for scope in scopes)


def principal_from_session(user_session: Any) -> Principal:
    """Adapt the existing browser session without changing its auth flow."""
    return Principal(
        id=user_session.id,
        auth_type="session",
        scopes=ALL_EXTERNAL_SCOPES,
        username=getattr(user_session, "username", ""),
        email=getattr(user_session, "email", ""),
        email_verified=getattr(user_session, "email_verified", False),
        name=getattr(user_session, "name", ""),
        given_name=getattr(user_session, "given_name", ""),
        family_name=getattr(user_session, "family_name", ""),
        roles=tuple(getattr(user_session, "roles", []) or []),
    )
