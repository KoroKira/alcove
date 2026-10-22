import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import TerminalLocal from './TerminalLocal';

vi.mock('../hooks/useAppConfig', () => ({
  useAppConfig: vi.fn(),
}));

import { useAppConfig } from '../hooks/useAppConfig';

describe('TerminalLocal', () => {
  it('does not contact localhost or render an iframe when terminal is not configured', () => {
    vi.mocked(useAppConfig).mockReturnValue({
      config: { ttydUrl: '' } as any,
      isLoadingConfig: false,
      configError: null,
      isConfigError: false,
    });

    render(<TerminalLocal />);

    expect(screen.getByRole('status')).toHaveTextContent('Terminal désactivé');
    expect(screen.queryByTitle('Terminal configuré')).not.toBeInTheDocument();
  });

  it('loads only the explicitly configured terminal URL', () => {
    vi.mocked(useAppConfig).mockReturnValue({
      config: { ttydUrl: 'https://terminal.example.test/' } as any,
      isLoadingConfig: false,
      configError: null,
      isConfigError: false,
    });

    render(<TerminalLocal />);

    expect(screen.getByTitle('Terminal configuré')).toHaveAttribute('src', 'https://terminal.example.test/');
    expect(screen.getByRole('status')).toHaveTextContent('Chargement du terminal');
  });
});
