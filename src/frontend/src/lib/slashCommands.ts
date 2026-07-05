/**
 * Slash-command menu for the Markdown editor. Registers a Monaco completion
 * provider triggered by "/" that inserts snippets (Mermaid, tables, callouts,
 * flashcards, headings, …) with tab-stops. Uses Monaco's native suggest widget,
 * so keyboard nav + filtering come for free.
 */

let registered = false;

interface SlashDef {
  cmd: string;               // without the leading slash
  detail: string;            // shown to the right in the widget
  body: string | (() => string); // snippet text (may be dynamic, e.g. date)
}

const SLASH_COMMANDS: SlashDef[] = [
  { cmd: 'mermaid', detail: 'Diagramme Mermaid', body: '```mermaid\nflowchart TD\n  ${1:A[Début]} --> ${2:B[Fin]}\n```\n' },
  { cmd: 'table', detail: 'Tableau', body: '| ${1:Colonne 1} | ${2:Colonne 2} |\n| --- | --- |\n| ${3:a} | ${4:b} |\n' },
  { cmd: 'flashcard', detail: 'Carte Q:/A:', body: 'Q: ${1:question}\nA: ${2:réponse}\n' },
  { cmd: 'note', detail: 'Callout Note', body: '> [!NOTE]\n> ${1:texte}\n' },
  { cmd: 'tip', detail: 'Callout Astuce', body: '> [!TIP]\n> ${1:texte}\n' },
  { cmd: 'warning', detail: 'Callout Attention', body: '> [!WARNING]\n> ${1:texte}\n' },
  { cmd: 'code', detail: 'Bloc de code', body: '```${1:js}\n${2:// code}\n```\n' },
  { cmd: 'todo', detail: 'Case à cocher', body: '- [ ] ${1:tâche}' },
  { cmd: 'h1', detail: 'Titre 1', body: '# ${1:Titre}' },
  { cmd: 'h2', detail: 'Titre 2', body: '## ${1:Titre}' },
  { cmd: 'h3', detail: 'Titre 3', body: '### ${1:Titre}' },
  { cmd: 'wikilink', detail: 'Lien vers un pad', body: '[[${1:nom-du-pad}]]' },
  { cmd: 'katex', detail: 'Formule mathématique', body: '$$\n${1:E = mc^2}\n$$\n' },
  { cmd: 'divider', detail: 'Séparateur', body: '\n---\n' },
  {
    cmd: 'date',
    detail: "Date d'aujourd'hui",
    body: () => new Date().toISOString().slice(0, 10),
  },
];

export function registerSlashCommands(monaco: any) {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider('markdown', {
    triggerCharacters: ['/'],
    provideCompletionItems(model: any, position: any) {
      const lineToCursor: string = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      // Only trigger when the "/" starts a token (line start or after whitespace).
      const match = lineToCursor.match(/(?:^|\s)\/(\w*)$/);
      if (!match) return { suggestions: [] };

      const typed = match[1];
      const startColumn = position.column - typed.length - 1; // include the "/"
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn,
        endColumn: position.column,
      };

      const suggestions = SLASH_COMMANDS.map((s, i) => ({
        label: `/${s.cmd}`,
        kind: monaco.languages.CompletionItemKind.Snippet,
        detail: s.detail,
        insertText: typeof s.body === 'function' ? s.body() : s.body,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        filterText: `/${s.cmd}`,
        sortText: String(i).padStart(2, '0'),
        range,
      }));

      return { suggestions };
    },
  });
}
