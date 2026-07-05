"""baseline (existing schema bootstrapped via create_all)

Revision ID: 5396c6b1f129
Revises: 
Create Date: 2026-07-05 18:32:46.015932
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '5396c6b1f129'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
