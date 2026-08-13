/// <reference types="vite/client" />

// Monaco's package.json doesn't expose its ESM subpaths through the "exports"
// field, so TypeScript's Bundler moduleResolution can't discover the types
// even though the runtime import works fine. Delegate to Monaco's own root
// type declarations — same content, different path.
declare module 'monaco-editor/esm/vs/editor/editor.api' {
  export * from 'monaco-editor';
}

declare module 'monaco-editor/esm/vs/basic-languages/monaco.contribution';

// `monaco-vim` ships no types — the initVimMode function is enough.
declare module 'monaco-vim' {
  export function initVimMode(
    editor: unknown,
    statusBarNode?: HTMLElement | null,
  ): { dispose: () => void };
}
