export interface RestoredDocument {
  content: string;
  updatedAt: string;
}

/** Read both content and the new concurrency baseline before replacing a local draft. */
export async function reloadRestoredDocument(padId: string): Promise<RestoredDocument> {
  const response = await fetch(`/api/pad/${padId}`);
  if (!response.ok) throw new Error(`Restauration effectuée, mais rechargement impossible (${response.status}).`);
  const data = await response.json();
  if (typeof data.content !== 'string' || typeof data.updated_at !== 'string' || !data.updated_at) {
    throw new Error('Restauration effectuée, mais la réponse est incomplète. Réessaie le chargement avant de modifier le document.');
  }
  return { content: data.content, updatedAt: data.updated_at };
}
