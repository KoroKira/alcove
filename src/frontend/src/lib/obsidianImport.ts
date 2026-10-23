export interface ObsidianImportResult {
  name: string;
  sourceKey: string;
  id?: string;
  error?: string;
}

type RelativeFile = File & { webkitRelativePath?: string };

function noteLocation(file: RelativeFile): { name: string; folder: string | null } {
  const path = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
  const segments = path.split('/').filter(part => part && part !== '.' && part !== '..');
  // Folder inputs include the selected vault's root directory. Strip that
  // container and preserve only the note's path inside the vault.
  const relative = file.webkitRelativePath ? segments.slice(1) : segments;
  const filename = relative.pop() || file.name;
  const name = filename.replace(/\.md$/i, '');
  return { name, folder: relative.length ? relative.join('/') : null };
}

function sourceKey(file: RelativeFile): string {
  return (file.webkitRelativePath || file.name).replace(/\\/g, '/');
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { detail?: unknown; message?: unknown };
    const detail = body.detail ?? body.message;
    if (typeof detail === 'string' && detail.trim()) return detail;
  } catch {
    // Fall through to a stable status message for non-JSON proxy errors.
  }
  return `Erreur serveur (${response.status})`;
}

/** Import Markdown notes into Alcove, preserving vault folders and reporting
 * every failed create. A note is considered successful only after the server
 * has acknowledged its content in the create request. */
export async function importObsidianFiles(
  files: File[],
  onProgress: (completed: number) => void = () => {},
  request: typeof fetch = fetch,
): Promise<ObsidianImportResult[]> {
  const notes = files
    .filter(file => /\.md$/i.test(file.name))
    .filter(file => !((file as RelativeFile).webkitRelativePath || '').split(/[\\/]/).some(part => part === '.obsidian' || part === '.trash'));
  const results: ObsidianImportResult[] = [];

  for (const file of notes) {
    const location = noteLocation(file as RelativeFile);
    try {
      if (!location.name.trim()) throw new Error('Nom de note vide');
      if (location.name.length > 100) throw new Error('Nom trop long (100 caractères maximum)');
      if (location.folder && location.folder.length > 80) throw new Error('Chemin de dossier trop long (80 caractères maximum)');

      const response = await request('/api/pad/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pad_type: 'document',
          display_name: location.name,
          content: await file.text(),
          ...(location.folder ? { folder: location.folder } : {}),
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const pad = await response.json() as { id?: unknown };
      if (typeof pad.id !== 'string' || !pad.id) throw new Error('Réponse serveur invalide : identifiant du pad absent');
      results.push({ name: location.name, sourceKey: sourceKey(file as RelativeFile), id: pad.id });
    } catch (cause) {
      results.push({
        name: location.name || file.name,
        sourceKey: sourceKey(file as RelativeFile),
        error: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      onProgress(results.length);
    }
  }

  return results;
}
