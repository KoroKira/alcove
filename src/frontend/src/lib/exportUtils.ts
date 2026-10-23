/** Escape untrusted text before inserting it into an HTML text context. */
export function escapeHtmlText(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}

/** Keep readable Unicode titles while excluding path separators and invalid filename characters. */
export function markdownFilename(title: string): string {
  const name = title.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').trim();
  return `${name || 'document'}.md`;
}

export function downloadMarkdown(content: string, title: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = markdownFilename(title);
  try {
    // Safari needs the download link to belong to the document.
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
