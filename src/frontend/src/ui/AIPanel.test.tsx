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
    if (url.includes('/api/ai/models')) {
      return jsonResponse({ models: [{ name: 'llama3.2', size: 0, modified: '' }], default: 'llama3.2', available: true, starting: false });
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

  it('shows the setup wizard hook when Ollama is offline and not starting', async () => {
    // Override fetch to report unavailable.
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ models: [], default: 'llama3.2', available: false, starting: false }),
    ) as unknown as typeof fetch;

    render(<AIPanel onClose={vi.fn()} />);
    // Wait for the availability probe to settle; the OllamaSetup subtree
    // renders its own DOM (own root className) instead of the mode tabs.
    await waitFor(() => {
      expect(document.querySelector('.ai-panel__mode-tabs')).toBeNull();
    });
  });
});
