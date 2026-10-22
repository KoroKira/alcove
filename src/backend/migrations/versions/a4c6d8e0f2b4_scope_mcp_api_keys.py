"""Add read/write scopes without expanding existing MCP credentials.

Revision ID: a4c6d8e0f2b4
Revises: f1a2b3c4d5e6
"""
from alembic import op
import sqlalchemy as sa

revision = "a4c6d8e0f2b4"
down_revision = "f1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade():
    # Existing credentials already had both operations; retain that bound.
    # New credentials default to read only, including direct SQL inserts.
    op.add_column("mcp_api_keys", sa.Column("scopes", sa.ARRAY(sa.String(16)), nullable=False,
                  server_default=sa.text("ARRAY['read', 'write']::varchar[]")), schema="pad_ws")
    op.alter_column("mcp_api_keys", "scopes", server_default=sa.text("ARRAY['read']::varchar[]"), schema="pad_ws")
    op.create_check_constraint("ck_mcp_api_keys_scopes", "mcp_api_keys",
        "cardinality(scopes) > 0 AND scopes <@ ARRAY['read', 'write']::varchar[]", schema="pad_ws")


def downgrade():
    # Removing scopes would silently upgrade every read-only key to write.
    # Preserve that boundary by revoking every key with a restricted bound.
    op.execute("UPDATE pad_ws.mcp_api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE NOT (scopes @> ARRAY['read', 'write']::varchar[])")
    op.drop_constraint("ck_mcp_api_keys_scopes", "mcp_api_keys", schema="pad_ws", type_="check")
    op.drop_column("mcp_api_keys", "scopes", schema="pad_ws")
