import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { analyzeCitations, renderWithCitations } from './chatTypes';

const sources = [{ n: 1 }, { n: 2 }, { n: 3 }];

describe('citation verification', () => {
  it('separates real references from invented ones', () => {
    expect(analyzeCitations('A [[1]] B [[3]][[3]] C [[7]]', sources)).toEqual({ verifiable: true, valid: [1, 3], invalid: [7] });
  });

  it('is not verifiable without numbered sources', () => {
    expect(analyzeCitations('A [[1]]', []).verifiable).toBe(false);
    expect(analyzeCitations('A [[1]]', [{}]).verifiable).toBe(false);
    expect(analyzeCitations('A [[1]]', undefined).verifiable).toBe(false);
  });

  it('renders invented references as inert, labelled marks instead of clickable chips', () => {
    const onCite = (() => { const calls: number[] = []; const f = (n: number) => calls.push(n); (f as any).calls = calls; return f; })();
    render(<p>{renderWithCitations('Vrai [[2]] faux [[9]]', onCite as any, new Set([1, 2, 3]))}</p>);
    expect(screen.getByRole('button', { name: 'Source 2' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Source 9' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Citation 9 sans source correspondante/ })).toBeInTheDocument();
  });

  it('keeps legacy behaviour when no source list is given', () => {
    render(<p>{renderWithCitations('Ref [[5]]', () => {})}</p>);
    expect(screen.getByRole('button', { name: 'Source 5' })).toBeInTheDocument();
  });
});
