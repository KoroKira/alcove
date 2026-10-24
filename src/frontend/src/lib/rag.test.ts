import { afterEach, describe, expect, it, vi } from 'vitest';
import { agenticRagChat, embedText, indexAll, indexPad } from './rag';
import { oneShotLocalOllama, streamLocalOllamaChat } from '../hooks/useOllama';

vi.mock('../hooks/useOllama', () => ({
  getOllamaUrl: () => '/api/ai/ollama',
  streamLocalOllamaChat: vi.fn().mockResolvedValue(undefined),
  oneShotLocalOllama: vi.fn().mockResolvedValue('{"queries":[]}'),
  fetchChatPreamble: vi.fn().mockResolvedValue({ system: '', defaultModel: 'llama3.2' }),
}));

describe('embedText', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses Ollama /api/embed and reads the embeddings response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ embeddings: [[0.1, 0.2]] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    await expect(embedText('hello')).resolves.toEqual([0.1, 0.2]);
    expect(fetchMock).toHaveBeenCalledWith('/api/ai/ollama/api/embed', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ model: 'nomic-embed-text', input: 'hello' }),
    }));
  });
});

describe('RAG indexing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports a failed empty-pad index cleanup instead of marking it done', async () => {
    const progress = vi.fn();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ display_name: 'Empty', text: '' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('failed', { status: 503 }));

    await expect(indexPad('pad-empty', progress)).rejects.toThrow('index-chunks 503');
    expect(progress).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('continues indexing later pads when empty-pad cleanup fails', async () => {
    const progress: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/ai/rag/indexable-list') {
        return new Response(JSON.stringify({ pads: [
          { pad_id: 'pad-empty', display_name: 'Empty', text: '' },
          { pad_id: 'pad-note', display_name: 'Note', text: 'searchable content' },
        ] }), { status: 200 });
      }
      if (url === '/api/ai/ollama/api/embed') {
        return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 });
      }
      if (url === '/api/ai/rag/index-chunks') {
        const body = JSON.parse(String(init?.body || '{}'));
        return new Response(body.pad_id === 'pad-empty' ? 'failed' : '{"indexed":1}', {
          status: body.pad_id === 'pad-empty' ? 503 : 200,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await indexAll(p => progress.push(p));
    expect(result).toEqual({ pads: 1, totalChunks: 1 });
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ padId: 'pad-empty', status: 'error', error: 'index-chunks 503' }),
      expect.objectContaining({ padId: 'pad-note', status: 'done', chunks: 1 }),
    ]));
  });
});

describe('RAG answer evidence prompt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('treats note titles as labels and requires exact values to come from excerpts', async () => {
    vi.mocked(oneShotLocalOllama).mockResolvedValueOnce('{"queries":[]}');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/ai/ollama/api/embed') {
        return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 });
      }
      if (url === '/api/ai/rag/knn') {
        return new Response(JSON.stringify({ results: [
          { score: 0.53, pad_id: 'pad-title', pad_name: 'Test Alcove 24 oct — renommé', chunk_text: 'Version A de test' },
          { score: 0.47, pad_id: 'pad-marker', pad_name: 'New document', chunk_text: 'ALCOVE_SMOKE_20261024: autosave and retrieval verification.' },
        ] }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await agenticRagChat('llama3.2:latest', 'What exact marker string appears in the note?', {
      onChunk: vi.fn(),
    }, { lang: 'en' });

    const messages = vi.mocked(streamLocalOllamaChat).mock.calls[0][1];
    const systemPrompt = messages[0].content;
    expect(systemPrompt).toContain('Source titles identify a note only; they are not evidence');
    expect(systemPrompt).toContain('copy the value exactly as it appears in an EXCERPT');
    expect(systemPrompt).toContain('Titre de la note (référence uniquement, pas une preuve) : Test Alcove 24 oct — renommé');
    expect(systemPrompt).toContain('ALCOVE_SMOKE_20261024: autosave and retrieval verification.');
  });
});
