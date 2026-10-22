import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const { startWorkspace, stopWorkspace, WorkspaceIntegrationDisabledError } = vi.hoisted(() => {
  class WorkspaceIntegrationDisabledError extends Error {
    constructor() {
      super('Workspace management is not configured on this Alcove instance.');
      this.name = 'WorkspaceIntegrationDisabledError';
    }
  }
  return { startWorkspace: vi.fn(), stopWorkspace: vi.fn(), WorkspaceIntegrationDisabledError };
});

vi.mock('../hooks/useWorkspace', () => ({
  WorkspaceIntegrationDisabledError,
  useWorkspace: () => ({
    workspaceState: undefined,
    isLoadingState: false,
    stateError: new WorkspaceIntegrationDisabledError(),
    startWorkspace,
    isStarting: false,
    stopWorkspace,
    isStopping: false,
  }),
}));

import { StateIndicator } from './StateIndicator';
import { ControlButton } from './buttons/ControlButton';

describe('workspace UI when the integration is disabled', () => {
  beforeEach(() => {
    startWorkspace.mockClear();
    stopWorkspace.mockClear();
  });

  it('explains that workspace status is unavailable by configuration', () => {
    render(<StateIndicator />);

    expect(screen.getByText('Workspace désactivé')).toBeTruthy();
  });

  it('does not offer an actionable start/stop control', () => {
    render(<ControlButton />);
    const button = screen.getByRole('button', { name: 'Workspace non configuré' });

    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(startWorkspace).not.toHaveBeenCalled();
    expect(stopWorkspace).not.toHaveBeenCalled();
  });
});
