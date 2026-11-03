// Bundles Monaco with the app instead of loading it from a CDN, so the editor works offline and loads reliably.
// Only the editor core is included: PaperDesk registers its own LaTeX and BibTeX languages (monacoSetup.ts).
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
