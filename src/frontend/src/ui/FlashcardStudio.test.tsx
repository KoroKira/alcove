import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FlashcardStudio from './FlashcardStudio';
import { SharingPolicy, type Tab } from '../hooks/usePadTabs';

// Tests focus on behavior visible to the user: sees the doc list, can select
// one, can extract cards, sees the front/back of a card, can rate it, sees
// the next card. Everything network-shaped is mocked at the fetch layer;
// the FSRS bookkeeping in localStorage is exercised for real (that IS the
// side-effect we care about).

function tab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'pad-doc-1',
    title: 'Ma note',
    ownerId: 'user-1',
    sharingPolicy: SharingPolicy.PRIVATE,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    padType: 'document',
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const noop = () => {};

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('FlashcardStudio', () => {
  it('lists selectable document pads (and hides non-document pads)', () => {
    render(
      <FlashcardStudio
        tabs={[
          tab({ id: 'pad-1', title: 'Doc A' }),
          tab({ id: 'pad-2', title: 'Doc B' }),
          tab({ id: 'pad-3', title: 'A canvas', padType: 'canvas' }),
        ]}
        onClose={noop}
        onSelectPad={noop}
      />,
    );

    expect(screen.getByText('Doc A')).toBeInTheDocument();
    expect(screen.getByText('Doc B')).toBeInTheDocument();
    expect(screen.queryByText('A canvas')).not.toBeInTheDocument();
  });

  it('empty-state guides the user before any extraction', () => {
    render(<FlashcardStudio tabs={[]} onClose={noop} onSelectPad={noop} />);
    expect(screen.getByText(/Aucun document/i)).toBeInTheDocument();
    // Both action buttons exist but stay disabled with no selection.
    expect(screen.getByRole('button', { name: /Extraire Q\/A/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Générer \(IA\)/i })).toBeDisabled();
  });

  it('extract → shows first card front only, then reveals back on click', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
      decks: [{
        padId: 'pad-1', padName: 'Doc A', cards: [
          { q: 'Capitale de la France ?', a: 'Paris' },
          { q: '2 + 2 ?', a: '4' },
        ],
      }],
    })) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(
      <FlashcardStudio
        tabs={[tab({ id: 'pad-1', title: 'Doc A' })]}
        onClose={noop}
        onSelectPad={noop}
      />,
    );

    await user.click(screen.getByText('Doc A'));
    await user.click(screen.getByRole('button', { name: /Extraire Q\/A/i }));

    // Card order is shuffled — assert on whichever question shows first.
    // Answer text is present in the DOM (back of the flip card) but the
    // "reveal" hint only appears while un-flipped.
    const firstQ = await waitFor(() => {
      const el =
        screen.queryByText(/Capitale de la France/) ||
        screen.queryByText(/2 \+ 2/);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(screen.getByText(/Cliquer pour révéler/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Raté/i })).not.toBeInTheDocument();

    // Reveal — Raté / Dur / Bien / Facile appear.
    await user.click(firstQ.closest('.fc-studio__card')!);
    await waitFor(() => expect(screen.getByRole('button', { name: /Raté/i })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Dur$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Bien/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Facile/i })).toBeInTheDocument();
  });

  it('answering "Bien" advances the queue and persists to localStorage', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
      decks: [{
        padId: 'pad-1', padName: 'Doc A', cards: [
          { q: 'Q1', a: 'A1' },
          { q: 'Q2', a: 'A2' },
        ],
      }],
    })) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(
      <FlashcardStudio
        tabs={[tab({ id: 'pad-1', title: 'Doc A' })]}
        onClose={noop}
        onSelectPad={noop}
      />,
    );

    await user.click(screen.getByText('Doc A'));
    await user.click(screen.getByRole('button', { name: /Extraire Q\/A/i }));

    // Queue order is shuffled — accept either Q1 or Q2 as the first card.
    const firstCard = await waitFor(() => {
      const q1 = screen.queryByText('Q1');
      const q2 = screen.queryByText('Q2');
      const found = q1 || q2;
      expect(found).not.toBeNull();
      return found!;
    });
    const firstText = firstCard.textContent;
    expect(screen.getByText(/1 \/ 2/)).toBeInTheDocument(); // progress "1 / 2"

    // Reveal + rate the current card as Good.
    await user.click(firstCard.closest('.fc-studio__card')!);
    await user.click(await screen.findByRole('button', { name: /Bien/i }));

    // Progress advanced to "2 / 2".
    await waitFor(() => expect(screen.getByText(/2 \/ 2/)).toBeInTheDocument());
    // The other card is now on screen (and it's a different question).
    const secondCard = firstText === 'Q1' ? 'Q2' : 'Q1';
    expect(screen.getByText(secondCard)).toBeInTheDocument();

    // localStorage got an FSRS record for the answered card.
    const stored = localStorage.getItem('alcove-quiz-fsrs');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    const anyReviewed = Object.values(parsed).some(
      (c: any) => c && typeof c.reps === 'number' && c.reps >= 1,
    );
    expect(anyReviewed).toBe(true);
  });

  it('shows an error when the backend returns no Q/A pairs', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ decks: [] })) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(
      <FlashcardStudio
        tabs={[tab({ id: 'pad-1', title: 'Doc A' })]}
        onClose={noop}
        onSelectPad={noop}
      />,
    );

    await user.click(screen.getByText('Doc A'));
    await user.click(screen.getByRole('button', { name: /Extraire Q\/A/i }));

    await waitFor(() => expect(screen.getByText(/Aucun bloc Q:\/A:/i)).toBeInTheDocument());
  });
});
