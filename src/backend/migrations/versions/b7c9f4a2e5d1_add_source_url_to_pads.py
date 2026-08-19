"""add source_url column to pads

URL canonique de la source ingérée (page web, vidéo YouTube, PDF distant,
podcast). Séparée du thumbnail : l'URL sert à afficher le domaine + favicon
sur la carte Dashboard, à re-fetch pour "Regenerate", et à dédupliquer
les futurs ingest.

Revision ID: b7c9f4a2e5d1
Revises: a3f8e2d1c9b4
Create Date: 2026-08-19 03:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b7c9f4a2e5d1'
down_revision: Union[str, None] = 'a3f8e2d1c9b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'pads',
        sa.Column('source_url', sa.Text(), nullable=True),
        schema='pad_ws',
    )


def downgrade() -> None:
    op.drop_column('pads', 'source_url', schema='pad_ws')
