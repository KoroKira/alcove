import { afterEach, describe, expect, it, vi } from 'vitest';
import { embedText } from './rag';

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
