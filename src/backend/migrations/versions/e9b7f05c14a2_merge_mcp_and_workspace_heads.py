"""Merge MCP API key auth and workspace feature migration heads.

Revision ID: e9b7f05c14a2
Revises: a4c6d8e0f2b4, d4e6b19f2a71
"""
from typing import Sequence, Union

from alembic import op  # noqa: F401

revision: str = "e9b7f05c14a2"
down_revision: Union[str, Sequence[str], None] = (
    "a4c6d8e0f2b4",
    "d4e6b19f2a71",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
