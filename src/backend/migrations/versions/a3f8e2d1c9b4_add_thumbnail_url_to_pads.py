"""add thumbnail_url column to pads

Ajoute une colonne dédiée pour l'URL de la miniature de carte —
YouTube API pour vidéos, OG-image pour pages web, cover page 1
pour PDF. Séparé de pad.data pour rester dans les selects listing
sans charger le blob data complet.

Revision ID: a3f8e2d1c9b4
Revises: 78e9e486c306
Create Date: 2026-08-19 02:15:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a3f8e2d1c9b4'
down_revision: Union[str, None] = '78e9e486c306'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'pads',
        sa.Column('thumbnail_url', sa.Text(), nullable=True),
        schema='pad_ws',
    )


def downgrade() -> None:
    op.drop_column('pads', 'thumbnail_url', schema='pad_ws')
