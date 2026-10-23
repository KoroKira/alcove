import { describe, expect, it } from 'vitest';
import { escapeHtmlText } from './exportUtils';

describe('escapeHtmlText', () => {
  it('keeps pad titles as text in exported HTML', () => {
    expect(escapeHtmlText(`<img src=x onerror="alert('x')"> & notes`))
      .toBe('&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; notes');
  });

  it('preserves ordinary Unicode titles', () => {
    expect(escapeHtmlText('Réunion — été')).toBe('Réunion — été');
  });
});
