import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadMarkdown, escapeHtmlText, markdownFilename } from './exportUtils';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('escapeHtmlText', () => {
  it('keeps pad titles as text in exported HTML', () => {
    expect(escapeHtmlText(`<img src=x onerror="alert('x')"> & notes`))
      .toBe('&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; notes');
  });

  it('preserves ordinary Unicode titles', () => {
    expect(escapeHtmlText('Réunion — été')).toBe('Réunion — été');
  });
});


describe('Markdown export', () => {
  it('keeps accented names readable and removes unsafe filename characters', () => {
    expect(markdownFilename('Réunion — été')).toBe('Réunion — été.md');
    expect(markdownFilename('../notes: quotidien?')).toBe('.._notes_ quotidien_.md');
    expect(markdownFilename(' ... ')).toBe('document.md');
  });

  it('attaches a download link and releases its object URL only after the click', () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn().mockReturnValue('blob:isolated-export');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.isConnected).toBe(true);
      expect(this.download).toBe('Réunion.md');
    });
    downloadMarkdown('Brouillon non encore sauvegardé', 'Réunion');
    expect(click).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0][0].type).toBe('text/markdown;charset=utf-8');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:isolated-export');
  });
});
