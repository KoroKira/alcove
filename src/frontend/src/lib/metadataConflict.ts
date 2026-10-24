/** A metadata edit advances a pad's timestamp without changing its body.
 * Retry once only when the current server body still matches the body we last
 * saved or loaded. A real concurrent edit keeps the normal conflict flow. */
export async function retryStructuredSaveAfterMetadataChange(
  padId: string,
  persistedData: unknown,
  draftData: unknown,
  request: typeof fetch = fetch,
): Promise<Response | null> {
  const latestResponse = await request(`/api/pad/${padId}`);
  if (!latestResponse.ok) throw new Error(`Impossible de relire le pad (${latestResponse.status}).`);
  const latest = await latestResponse.json();
  if (typeof latest?.updated_at !== 'string' || !latest.updated_at) return null;
  const withoutVersion = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const { updated_at: _version, ...body } = value as Record<string, unknown>;
    return body;
  };
  if (JSON.stringify(withoutVersion(latest.data)) !== JSON.stringify(withoutVersion(persistedData))) return null;
  return request(`/api/pad/${padId}/data`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: draftData, expected_updated_at: latest.updated_at }),
  });
}
