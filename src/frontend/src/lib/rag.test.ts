import { afterEach, describe, expect, it, vi } from 'vitest';
import { embedText, indexAll, indexPad } from './rag';

vi.mock('../hooks/useOllama', () => ({
  getOllamaUrl: () => '/api/ai/ollama',
  streamLocalOllamaChat: vi.fn(),
  oneShotLocalOllama: vi.fn(),
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
