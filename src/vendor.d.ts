declare module 'unzipper';
declare module 'archiver';
declare module 'monaco-emacs' {
  import type { editor } from 'monaco-editor';
  export class EmacsExtension {
    constructor(editor: editor.IStandaloneCodeEditor);
    start(): void;
    dispose(): void;
    onDidChangeKey(listener: (key: string) => void): void;
  }
}
