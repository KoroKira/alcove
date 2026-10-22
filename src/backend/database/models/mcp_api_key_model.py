from sqlalchemy import ARRAY, CheckConstraint, Column, String, DateTime, ForeignKey, Index, text
from sqlalchemy import UUID as SQLUUID

from .base_model import Base, BaseModel, SCHEMA_NAME


class McpApiKey(Base, BaseModel):
    """Machine-to-machine API key for the MCP endpoint.

    Separate from user web sessions (Keycloak/OIDC) — this is how non-browser
    clients (hub-bot, agents) authenticate `tools/call`. Lifecycle (create /
    verify / revoke / rotate) lives in services.mcp_api_key_service, which is
    the only code allowed to touch secret_hash.

    Never stores the raw secret, only its digest. `public_id` is a cleartext
    lookup prefix so verification is an indexed point query instead of a
    scan over every row's hash.
    """
    __tablename__ = "mcp_api_keys"
    __table_args__ = (
        Index("ix_mcp_api_keys_owner_id", "owner_id"),
        CheckConstraint("cardinality(scopes) > 0 AND scopes <@ ARRAY['read', 'write']::varchar[]",
                        name="ck_mcp_api_keys_scopes"),
        {"schema": SCHEMA_NAME},
    )

    owner_id = Column(
        SQLUUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.users.id", ondelete="CASCADE"),
        nullable=False,
    )
    public_id = Column(String(32), nullable=False, unique=True, index=True)
    secret_hash = Column(String(64), nullable=False)
    name = Column(String(254), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    last_used_at = Column(DateTime(timezone=True), nullable=True)
    scopes = Column(ARRAY(String(16)), nullable=False, default=lambda: ["read"],
                    server_default=text("ARRAY['read']::varchar[]"))

    def __repr__(self) -> str:
        return f"<McpApiKey(id='{self.id}', owner_id='{self.owner_id}', public_id='{self.public_id}')>"
