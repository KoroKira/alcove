import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import McpConnections from './McpConnections';

const key = { public_id: 'key-1', name: 'Codex personnel', scopes: ['read'], expires_at: '2027-01-01T00:00:00Z', revoked_at: null };
const response = (body: unknown, status = 200) => ({ ok: status < 400, json: async () => body } as Response);
function setup(keys: unknown[] = []) {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(response({ endpoint: 'https://alcove.example/mcp', oauth: { enabled: true } }))
    .mockResolvedValueOnce(response({ keys }));
  vi.stubGlobal('fetch', fetchMock);
  render(<McpConnections />);
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());

describe('MCP connections', () => {
  it('creates an expiring read-only key by default and shows its secret only once', async () => {
    const fetchMock = setup();
    fetchMock.mockResolvedValueOnce(response({ key, token: 'amk_test_secret' }, 201));
    fireEvent.change(await screen.findByLabelText('Nom de la connexion'), { target: { value: 'Codex personnel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Créer la clé' }));
    const secret = await screen.findByLabelText('Clé personnelle — affichée une seule fois');
    expect(secret).toHaveAttribute('type', 'password');
    expect(fetchMock).toHaveBeenLastCalledWith('/api/mcp/keys', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ name: 'Codex personnel', allow_write: false, expires_days: 90 }),
    }));
    expect(screen.getByRole('button', { name: 'Créer la clé' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'J’ai enregistré la clé' }));
    expect(screen.queryByDisplayValue('amk_test_secret')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Nom de la connexion')).toHaveFocus());
  });

  it('requires confirmation before revoking a connection', async () => {
    const fetchMock = setup([key]);
    fireEvent.click(await screen.findByRole('button', { name: 'Révoquer Codex personnel' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValueOnce(response({ revoked: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la révocation de Codex personnel' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('est révoquée'));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/mcp/keys/key-1/revoke', { method: 'POST' });
  });

  it('reports an unavailable connection service without pretending there are no keys', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ detail: 'Reconnectez-vous à Alcove.' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    render(<McpConnections />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Reconnectez-vous à Alcove.');
    expect(screen.queryByText('Aucune clé personnelle.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Créer la clé' })).not.toBeInTheDocument();
    fetchMock.mockResolvedValueOnce(response({ endpoint: 'https://alcove.example/mcp' }))
      .mockResolvedValueOnce(response({ keys: [key] }));
    fireEvent.click(screen.getByRole('button', { name: 'Recharger les connexions' }));
    expect(await screen.findByRole('button', { name: 'Révoquer Codex personnel' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('focuses the safe cancellation action and supports Escape without revoking', async () => {
    const fetchMock = setup([key]);
    fireEvent.click(await screen.findByRole('button', { name: 'Révoquer Codex personnel' }));
    expect(screen.getByRole('button', { name: 'Annuler' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('group', { name: 'Révoquer Codex personnel' }), { key: 'Escape' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Révoquer Codex personnel' })).toHaveFocus());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

});
