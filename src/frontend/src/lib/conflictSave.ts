/** Save a local document draft after a concurrency conflict without silently
 * replacing the current server version: snapshot that version first, then
 * retry with its freshly-read optimistic-concurrency token. */
export async function saveDocumentAfterConflict(
  padId: string,
  saveUrl: string,
  makeBody: (updatedAt: string) => Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<string> {
  const latestResponse = await request(`/api/pad/${padId}`);
  if (!latestResponse.ok) throw new Error(`Impossible de relire le document (${latestResponse.status}).`);
  const latest = await latestResponse.json() as { updated_at?: unknown };
  if (typeof latest.updated_at !== 'string' || !latest.updated_at) {
    throw new Error('La version serveur ne fournit pas de date de modification.');
  }

  const snapshotResponse = await request(`/api/pad/${padId}/versions/snapshot`, { method: 'POST' });
  if (!snapshotResponse.ok) throw new Error(`Impossible de protéger la version serveur (${snapshotResponse.status}).`);

  const saveResponse = await request(saveUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(makeBody(latest.updated_at)),
  });
  if (!saveResponse.ok) {
    throw new Error(saveResponse.status === 409
      ? 'Le document a encore changé. Réessaie après avoir relu la version serveur.'
      : `Impossible d’enregistrer le brouillon (${saveResponse.status}).`);
  }
  const saved = await saveResponse.json().catch(() => null) as { updated_at?: unknown } | null;
  return typeof saved?.updated_at === 'string' && saved.updated_at ? saved.updated_at : latest.updated_at;
}
