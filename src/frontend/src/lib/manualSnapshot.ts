/** Persist a manual revision snapshot after the caller has confirmed its
 * current document state is saved. */
export async function createManualSnapshot(padId: string, request: typeof fetch = fetch): Promise<void> {
  const response = await request(`/api/pad/${padId}/versions/snapshot`, { method: 'POST' });
  if (!response.ok) throw new Error(`Snapshot request failed (${response.status}).`);
}
