import type { editor } from 'monaco-editor';

export type Keymap = 'default' | 'vim' | 'emacs';
export const KEYMAPS: { value: Keymap; label: string }[] = [{ value: 'default', label: 'Default' }, { value: 'vim', label: 'Vim' }, { value: 'emacs', label: 'Emacs' }];

/**
 * Turns Vim or Emacs key bindings on for a live editor and returns a function that turns them off again, so the
 * setting can change without recreating the editor. Each keymap's code is downloaded only when it is first chosen.
 */
export async function attachKeymap(ed: editor.IStandaloneCodeEditor, mode: Keymap, status: HTMLElement | null): Promise<() => void> {
  if (mode === 'vim') {
    const { initVimMode } = await import('monaco-vim');
    const vim = initVimMode(ed, status);
    return () => vim.dispose();
  }
  if (mode === 'emacs') {
    const { EmacsExtension } = await import('monaco-emacs');
    const emacs = new EmacsExtension(ed);
    if (status) emacs.onDidChangeKey((key: string) => { status.textContent = key; });
    emacs.start();
    return () => { emacs.dispose(); if (status) status.textContent = ''; };
  }
  return () => undefined;
}
