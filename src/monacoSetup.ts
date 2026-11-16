import type { Monaco } from '@monaco-editor/react';
import {
  collectCitations,
  collectLabels,
  COMMANDS,
  completionContext,
  ENVIRONMENTS,
  projectPaths,
  collectTypstReferences,
  TYPST_FUNCTIONS,
  typstCompletionContext,
  typstPaths,
} from './lib/completion';
import type { ProjectFile } from './lib/project';

/** The open project's files, for label, citation and path suggestions. Set by the editor. */
let projectFiles: () => ProjectFile[] = () => [];
export const setCompletionFiles = (get: () => ProjectFile[]) => {
  projectFiles = get;
};

let registered = false;

/** Registers LaTeX, Typst and BibTeX highlighting and the two editor themes. Safe to call more than once. */
export function setupMonaco(monaco: Monaco) {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: 'latex', extensions: ['.tex', '.sty', '.cls'] });
  monaco.languages.setMonarchTokensProvider('latex', {
    tokenizer: {
      root: [
        [/%.*$/, 'comment'],
        [/(\\(?:begin|end))(\s*)(\{)([^}]*)(\})/, ['keyword', '', 'delimiter.curly', 'type', 'delimiter.curly']],
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
      inlineMath: [
        [/\$/, { token: 'string.math', next: '@pop' }],
        [/\\[a-zA-Z]+/, 'string.math.command'],
        [/[^$\\]+/, 'string.math'],
        [/./, 'string.math'],
      ],
      displayMath: [
        [/\$\$/, { token: 'string.math', next: '@pop' }],
        [/\\[a-zA-Z]+/, 'string.math.command'],
        [/[^$\\]+/, 'string.math'],
        [/./, 'string.math'],
      ],
      bracketMath: [
        [/\\\]/, { token: 'string.math', next: '@pop' }],
        [/\\[a-zA-Z]+/, 'string.math.command'],
        [/[^\\]+/, 'string.math'],
        [/./, 'string.math'],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration('latex', {
    comments: { lineComment: '%' },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '$', close: '$' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '$', close: '$' },
    ],
  });
  monaco.languages.registerCompletionItemProvider('latex', {
    triggerCharacters: ['\\', '{', ','],
    provideCompletionItems(model, position) {
      const line = model.getLineContent(position.lineNumber);
      const before = line.slice(0, position.column - 1),
        after = line.slice(position.column - 1);
      const ctx = completionContext(before);
      if (!ctx) return { suggestions: [] };
      const K = monaco.languages.CompletionItemKind,
        snippet = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
      const start = position.column - ctx.partial.length;
      const range = (from = start, extra = 0) =>
        new monaco.Range(position.lineNumber, from, position.lineNumber, position.column + extra);
      const files = projectFiles();
      if (ctx.kind === 'command') {
        return {
          suggestions: COMMANDS.map(([name, body, detail]) => ({
            label: `\\${name}`,
            filterText: `\\${name}`,
            kind: K.Function,
            detail,
            insertText: body,
            insertTextRules: snippet,
            range: range(start - 1),
          })),
        };
      }
      if (ctx.kind === 'env') {
        // Typing "{" auto-closes it, so replace that "}" too; \begin also gets its matching \end.
        const closes = after.startsWith('}') ? 1 : 0,
          opening = /\\begin\{[^}]*$/.test(before);
        return {
          suggestions: ENVIRONMENTS.map(([name, body]) => ({
            label: name,
            kind: K.Struct,
            detail: opening ? `\\begin{${name}} … \\end{${name}}` : 'Environment',
            insertText: opening ? `${name}}\n${body}\n\\end{${name}}` : `${name}}`,
            insertTextRules: snippet,
            range: range(start, closes),
          })),
        };
      }
      // Picking a name also steps over the closing brace, so typing continues after the command.
      const close = after.startsWith('}') ? 1 : 0;
      const name = (value: string) => ({ insertText: `${value}}`, range: range(start, close) });
      if (ctx.kind === 'ref')
        return {
          suggestions: collectLabels(files).map((l) => ({
            label: l.label,
            kind: K.Reference,
            detail: `${l.file}:${l.line}`,
            ...name(l.label),
          })),
        };
      if (ctx.kind === 'cite')
        return {
          suggestions: collectCitations(files).map((c) => ({
            label: c.key,
            kind: K.Value,
            detail: c.detail,
            ...name(c.key),
          })),
        };
      return { suggestions: projectPaths(files, ctx.kind).map((p) => ({ label: p, kind: K.File, ...name(p) })) };
    },
  });

  // Typst: markup with `#` code, `$` math, `//` comments, `= Headings`, <labels> and @references.
  monaco.languages.register({ id: 'typst', extensions: ['.typ'] });
  monaco.languages.setMonarchTokensProvider('typst', {
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\/\*/, { token: 'comment', next: '@blockComment' }],
        [/^\s*=+\s.*$/, 'keyword.heading'],
        [
          /#(?:let|set|show|import|include|if|else|for|while|in|return|break|continue|context|none|auto|true|false)\b/,
          'keyword',
        ],
        [/#[a-zA-Z_][\w.-]*/, 'keyword'],
        [/"/, { token: 'string', next: '@string' }],
        [/\$/, { token: 'string.math', next: '@math' }],
        [/<[a-zA-Z_][\w:.-]*>/, 'type'],
        [/@[a-zA-Z_][\w:.-]*/, 'type'],
        [/\\./, 'keyword'],
        [/[{}]/, 'delimiter.curly'],
        [/[[\]]/, 'delimiter.square'],
      ],
      blockComment: [
        [/\*\//, { token: 'comment', next: '@pop' }],
        [/[^*]+/, 'comment'],
        [/./, 'comment'],
      ],
      string: [
        [/\\./, 'string'],
        [/"/, { token: 'string', next: '@pop' }],
        [/[^"\\]+/, 'string'],
      ],
      math: [
        [/\\./, 'string.math'],
        [/\$/, { token: 'string.math', next: '@pop' }],
        [/[a-zA-Z]{2,}/, 'string.math.command'],
        [/[^$\\a-zA-Z]+/, 'string.math'],
        [/./, 'string.math'],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration('typst', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] },
      { open: '$', close: '$' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: '$', close: '$' },
      { open: '*', close: '*' },
      { open: '_', close: '_' },
    ],
    // A line that opens a bracket indents the next one; a closing bracket goes back out.
    indentationRules: {
      increaseIndentPattern: /^.*[{[(][^}\])]*$/,
      decreaseIndentPattern: /^\s*[}\])]/,
    },
  });

  monaco.languages.registerCompletionItemProvider('typst', {
    triggerCharacters: ['#', '@', '"', '/'],
    provideCompletionItems(model, position) {
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const ctx = typstCompletionContext(before);
      if (!ctx) return { suggestions: [] };
      const K = monaco.languages.CompletionItemKind,
        snippet = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
      const range = new monaco.Range(
        position.lineNumber,
        position.column - ctx.partial.length,
        position.lineNumber,
        position.column,
      );
      const files = projectFiles();
      // Editor models are named "<project id>/<file>"; paths are written relative to the file being edited.
      const file = model.uri.path.replace(/^\/?[^/]+\//, '');
      if (ctx.kind === 'function')
        return {
          suggestions: TYPST_FUNCTIONS.map(([name, body, detail]) => ({
            label: `#${name}`,
            filterText: name,
            kind: /^(set|show|let|import|include)$/.test(name) ? K.Keyword : K.Function,
            detail,
            insertText: body,
            insertTextRules: snippet,
            range,
          })),
        };
      if (ctx.kind === 'ref')
        return {
          suggestions: collectTypstReferences(files).map((r) => ({
            label: `@${r.key}`,
            filterText: r.key,
            kind: K.Reference,
            detail: r.detail,
            insertText: r.key,
            range,
          })),
        };
      return {
        suggestions: typstPaths(files, ctx.files, file).map((p) => ({
          label: p,
          kind: K.File,
          insertText: p,
          range,
        })),
      };
    },
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
