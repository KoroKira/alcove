import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CanvasErrorBoundary from './CanvasErrorBoundary';
import ErrorBoundary from './ErrorBoundary';

afterEach(() => vi.restoreAllMocks());

describe('CanvasErrorBoundary', () => {
  it('keeps global navigation available and remounts the canvas on retry', () => {
    const onOpenLibrary = vi.fn();
    let shouldThrow = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    function Canvas() {
      if (shouldThrow) throw new Error('canvas render failed');
      return <div>Canvas restored</div>;
    }

    render(
      <>
        <nav aria-label="Navigation principale"><button>Accueil</button></nav>
        <CanvasErrorBoundary onOpenLibrary={onOpenLibrary}>
          <Canvas />
        </CanvasErrorBoundary>
      </>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Les dernières modifications peuvent ne pas avoir été enregistrées.');
    expect(screen.getByRole('navigation', { name: 'Navigation principale' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir l’accueil' }));
    expect(onOpenLibrary).toHaveBeenCalledOnce();

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer le canevas' }));
    expect(screen.getByText('Canvas restored')).toBeInTheDocument();
  });
});

describe('ErrorBoundary', () => {
  it('does not claim unsaved data is safe and offers a real reload', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function BrokenApp(): never { throw new Error('app render failed'); }

    render(<ErrorBoundary><BrokenApp /></ErrorBoundary>);

    expect(screen.getByRole('alert')).toHaveTextContent('Les dernières modifications peuvent ne pas avoir été enregistrées');
    expect(screen.getByRole('button', { name: 'Recharger la page' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Réessayer sans recharger' })).not.toBeInTheDocument();
  });
});
