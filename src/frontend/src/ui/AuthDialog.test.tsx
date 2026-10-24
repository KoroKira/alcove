import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AuthDialog from './AuthDialog';

vi.mock('@atyrode/excalidraw', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../hooks/useAppConfig', () => ({ useAppConfig: () => ({ config: undefined }) }));
vi.mock('../lib/posthog', () => ({ capture: vi.fn() }));

afterEach(() => {
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

describe('AuthDialog', () => {
  it('explains an expired or replayed login state and removes the stale query flag', async () => {
    window.history.replaceState({}, '', '/?auth_error=state&keep=1#workspace');

    render(<AuthDialog />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La connexion a expiré ou a déjà été utilisée. Relancez-la avec le bouton ci-dessous.',
    );
    expect(screen.getByRole('button', { name: 'Se connecter' })).toBeInTheDocument();
    await waitFor(() => expect(window.location.href).toContain('/?keep=1#workspace'));
  });

  it('does not show a login error for a normal visit', () => {
    render(<AuthDialog />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
