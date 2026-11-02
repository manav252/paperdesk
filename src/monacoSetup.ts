import type { Monaco } from '@monaco-editor/react';

let registered = false;

/** Registers LaTeX/BibTeX highlighting and the two editor themes. Safe to call more than once. */
export function setupMonaco(monaco: Monaco) {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: 'latex', extensions: ['.tex', '.sty', '.cls'] });
  monaco.languages.setMonarchTokensProvider('latex', {
    tokenizer: {
      root: [
        [/%.*$/, 'comment'],
        [/(\\(?:begin|end))(\s*)(\{)([^}]*)(\})/,['keyword', '', 'delimiter.curly', 'type', 'delimiter.curly']],
        [/\\(section|subsection|subsubsection|chapter|part|paragraph|title|author|date)\*?/, 'keyword.heading'],
        [/\\[a-zA-Z@]+\*?/, 'keyword'],
        [/\\./, 'keyword'],
        [/\$\$/, { token: 'string.math', next: '@displayMath' }],
        [/\$/, { token: 'string.math', next: '@inlineMath' }],
        [/\\\[/, { token: 'string.math', next: '@bracketMath' }],
        [/[{}]/, 'delimiter.curly'],
        [/[[\]]/, 'delimiter.square'],
        [/[&~]/, 'operator'],
      ],
      inlineMath: [[/\$/, { token: 'string.math', next: '@pop' }], [/\\[a-zA-Z]+/, 'string.math.command'], [/[^$\\]+/, 'string.math'], [/./, 'string.math']],
      displayMath: [[/\$\$/, { token: 'string.math', next: '@pop' }], [/\\[a-zA-Z]+/, 'string.math.command'], [/[^$\\]+/, 'string.math'], [/./, 'string.math']],
      bracketMath: [[/\\\]/, { token: 'string.math', next: '@pop' }], [/\\[a-zA-Z]+/, 'string.math.command'], [/[^\\]+/, 'string.math'], [/./, 'string.math']],
    },
  });
  monaco.languages.setLanguageConfiguration('latex', {
    comments: { lineComment: '%' },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '$', close: '$' }],
    surroundingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '$', close: '$' }],
  });

  monaco.languages.register({ id: 'bibtex', extensions: ['.bib'] });
  monaco.languages.setMonarchTokensProvider('bibtex', {
    tokenizer: {
      root: [
        [/%.*$/, 'comment'],
        [/@[a-zA-Z]+/, 'keyword'],
        [/\b[a-zA-Z]+(?=\s*=)/, 'type'],
        [/"[^"]*"/, 'string'],
        [/[{}]/, 'delimiter.curly'],
        [/\d+/, 'number'],
      ],
    },
  });

  monaco.editor.defineTheme('paperdesk-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8a8f98', fontStyle: 'italic' },
      { token: 'keyword', foreground: '1f6fb2' },
      { token: 'keyword.heading', foreground: '1a7f5a', fontStyle: 'bold' },
      { token: 'type', foreground: '9a4d00' },
      { token: 'string.math', foreground: '7a3e9d' },
      { token: 'string.math.command', foreground: 'a3348b' },
      { token: 'delimiter.curly', foreground: '5b6370' },
      { token: 'string', foreground: '0f7b6c' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.lineHighlightBackground': '#f3f6f9',
      'editorLineNumber.foreground': '#a3abb5',
      'editorLineNumber.activeForeground': '#3c4550',
      'editorGutter.background': '#f8f9fb',
      'editor.selectionBackground': '#cfe3ff',
      'editorIndentGuide.background1': '#eceff3',
    },
  });

  monaco.editor.defineTheme('paperdesk-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '7d8692', fontStyle: 'italic' },
      { token: 'keyword', foreground: '79b8ff' },
      { token: 'keyword.heading', foreground: '6fd3a6', fontStyle: 'bold' },
      { token: 'type', foreground: 'f0b46c' },
      { token: 'string.math', foreground: 'd2a8ff' },
      { token: 'string.math.command', foreground: 'f692ce' },
      { token: 'delimiter.curly', foreground: 'a3acb8' },
      { token: 'string', foreground: '7ee0c3' },
    ],
    colors: {
      'editor.background': '#1a1f25',
      'editor.lineHighlightBackground': '#222831',
      'editorLineNumber.foreground': '#5b6571',
      'editorLineNumber.activeForeground': '#c9d1d9',
      'editorGutter.background': '#171b21',
      'editor.selectionBackground': '#2f4a6b',
      'editorIndentGuide.background1': '#262c34',
    },
  });
}
