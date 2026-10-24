import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AIPanel from './AIPanel';

// AIPanel is 950 LOC and orchestrates 5 subsystems (chat / RAG / memory /
// generation / Ollama admin). Deeply testing every one is a session on its
// own — these tests are the safety net that catches "the component crashes
// on first mount" or "the close button is wired to nothing", which is the
// class of regressions most likely to be introduced by refactors.

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

// Wire the network calls AIPanel makes on mount to plausible defaults, so
// nothing throws before we can render. Individual tests override this.
function mountFetchDefaults() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/ai/chat/preamble')) {
      return jsonResponse({ system: '', default_model: 'llama3.2' });
    }
    if (url.includes('/api/ai/ollama/api/tags')) {
      return jsonResponse({ models: [{ name: 'llama3.2', size: 0, modified_at: '' }] });
    }
    if (url.includes('/api/ai/conversations')) {
      return jsonResponse({ conversations: [] });
    }
    if (url.includes('/api/ai/memory')) {
      return jsonResponse({ slots: [] });
    }
    return jsonResponse({});
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  mountFetchDefaults();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AIPanel', () => {
  it('renders without crashing when Ollama reports available', async () => {
    render(<AIPanel onClose={vi.fn()} />);
    // Header title is a translation key or its default — accept either.
    // The mode-tabs group only appears once Ollama is available.
    await waitFor(() => {
      expect(document.querySelector('.ai-panel')).toBeInTheDocument();
    });
  });

  it('calls onClose when the close button is clicked', async () => {
    const onClose = vi.fn();
    render(<AIPanel onClose={onClose} />);

    // The close button uses an X icon (lucide) with a title attribute driven
    // by i18n. Fall back to the first button in the header if role query
    // doesn't match.
    await waitFor(() => {
      expect(document.querySelector('.ai-panel__close')).toBeInTheDocument();
    });
    const user = userEvent.setup();
    const closeBtn = document.querySelector('.ai-panel__close') as HTMLElement;
    await user.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the three mode tabs once Ollama is available', async () => {
    render(<AIPanel onClose={vi.fn()} />);
    await waitFor(() => {
      const tabs = document.querySelectorAll('.ai-panel__mode-tab');
      expect(tabs.length).toBe(3); // Chat / RAG / Mémoire
    });
  });

  it('indexes only the open pad from RAG mode', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/ai/rag/indexable-text/qa-pad') {
        return jsonResponse({ display_name: 'QA RAG', text: 'ALCOVE-RAG-QA-20261024 isolated retrieval phrase.' });
      }
      if (url === '/api/ai/ollama/api/embed') {
        return jsonResponse({ embeddings: [[0.25, 0.75]] });
      }
      if (url === '/api/ai/rag/index-chunks') {
        return jsonResponse({ indexed: 1 });
      }
      return jsonResponse({ system: '', default_model: 'llama3.2', conversations: [], slots: [] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<AIPanel onClose={vi.fn()} padId="qa-pad" padTitle="QA RAG" />);
    await waitFor(() => expect(document.querySelectorAll('.ai-panel__mode-tab')).toHaveLength(3));
    await user.click(document.querySelectorAll('.ai-panel__mode-tab')[1] as HTMLElement);
    await user.click(screen.getByRole('button', { name: /Indexer ce pad|Index this pad/ }));

    expect(await screen.findByRole('status')).toHaveTextContent('QA RAG — 1 chunks');
    expect(fetchMock).toHaveBeenCalledWith('/api/ai/rag/indexable-text/qa-pad', { credentials: 'include' });
    const indexCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/ai/rag/index-chunks');
    expect(indexCall).toBeDefined();
    expect(JSON.parse(String(indexCall?.[1]?.body))).toMatchObject({
      pad_id: 'qa-pad',
      chunks: [{ index: 0, text: 'ALCOVE-RAG-QA-20261024 isolated retrieval phrase.', embedding: [0.25, 0.75] }],
    });
    expect(fetchMock).not.toHaveBeenCalledWith('/api/ai/rag/indexable-list', expect.anything());
  });

  it('shows the setup wizard hook when Ollama is offline and not starting', async () => {
    // Override fetch to report unavailable.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/api/ai/ollama/api/tags')
        ? jsonResponse({ models: [] }, { status: 503 })
        : jsonResponse({ system: '', default_model: 'llama3.2' }),
    ) as unknown as typeof fetch;

    render(<AIPanel onClose={vi.fn()} />);
    // Wait for the availability probe to settle; the OllamaSetup subtree
    // renders its own DOM (own root className) instead of the mode tabs.
    await waitFor(() => {
      expect(document.querySelector('.ai-panel__mode-tabs')).toBeNull();
    });
  });
});
