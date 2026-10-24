import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import UnifiedAddModal from './UnifiedAddModal';

function renderModal() {
  const onImportObsidian = vi.fn();
  const onClose = vi.fn();
  render(
    <UnifiedAddModal
      onClose={onClose}
      onIngest={vi.fn()}
      onImportObsidian={onImportObsidian}
      onImportBookmarks={vi.fn()}
      onShowBookmarklet={vi.fn()}
      onQuickCapture={vi.fn()}
      onCreateCanvas={vi.fn()}
      onCreateDocument={vi.fn()}
      onCreateKanban={vi.fn()}
      onCreateGantt={vi.fn()}
      onCreateLatex={vi.fn()}
      onCreateDatabase={vi.fn()}
      onCreateDaily={vi.fn()}
    />,
  );
  return { onImportObsidian, onClose };
}

describe('UnifiedAddModal', () => {
  it('describes the current Obsidian Markdown and folder import accurately', () => {
    const { onImportObsidian, onClose } = renderModal();
    const importButton = screen.getByRole('button', { name: /Importer un vault Obsidian/ });

    expect(importButton).toHaveTextContent('Notes Markdown importées avec leurs dossiers');
    fireEvent.click(importButton);
    expect(onImportObsidian).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
