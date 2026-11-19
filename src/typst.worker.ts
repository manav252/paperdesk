/// <reference lib="webworker" />
import init, { TypstCompilerBuilder, type TypstCompiler } from '@myriaddreamin/typst-ts-web-compiler';
import wasmUrl from '@myriaddreamin/typst-ts-web-compiler/wasm?url';
import type { LiveDiagnostic, WorkerRequest, WorkerResponse } from './lib/typstLive';

// The Typst compiler for the live preview. One instance lives as long as the editor, so each compile reuses what
// the previous one worked out and only redoes what an edit changed.
const ctx = self as unknown as DedicatedWorkerGlobalScope;
let compiler: Promise<TypstCompiler> | null = null;

type FontManifest = { fonts: { file: string; info: unknown[]; conditions: unknown }[] };

/** Fonts are registered from their metadata and downloaded only when a document first uses them. */
function loadFont(url: string) {
  return () => {
    // The compiler asks for font data synchronously, which only a synchronous request can answer.
    const request = new XMLHttpRequest();
    request.open('GET', url, false);
    request.overrideMimeType('text/plain; charset=x-user-defined');
    request.send(null);
    if (request.status !== 200) return new Uint8Array();
    const text = request.responseText;
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return bytes;
  };
}

async function start(fontsUrl: string) {
  const [wasm, manifest] = await Promise.all([
    fetch(wasmUrl).then((r) => r.arrayBuffer()),
    fetch(`${fontsUrl}fonts.json`).then((r) => r.json() as Promise<FontManifest>),
  ]);
  await init({ module_or_path: wasm });
  const builder = new TypstCompilerBuilder();
  builder.set_dummy_access_model();
  for (const font of manifest.fonts)
    await builder.add_lazy_font({ info: font.info, conditions: font.conditions }, loadFont(`${fontsUrl}${font.file}`));
  return builder.build();
}

ctx.onmessage = async ({ data: message }: MessageEvent<WorkerRequest>) => {
  if (message.type === 'init') {
    compiler ??= start(message.fontsUrl);
    return;
  }
  const reply = (response: WorkerResponse, transfer: Transferable[] = []) => ctx.postMessage(response, transfer);
  try {
    if (!compiler) throw new Error('The Typst compiler was not started.');
    const typst = await compiler;
    if (message.reset) typst.reset_shadow();
    for (const path of message.removed) typst.unmap_shadow(path);
    for (const file of message.sources) typst.add_source(file.path, file.content);
    for (const file of message.binaries) typst.map_shadow(file.path, file.bytes);
    const started = performance.now();
    // Diagnostics format 3: structured entries with the file and a zero-based range.
    const output = typst.compile(message.main, null, 'pdf', 3) as {
      result?: Uint8Array;
      diagnostics?: LiveDiagnostic[];
    };
    const ms = Math.round(performance.now() - started);
    const pdf = output.result instanceof Uint8Array ? output.result : null;
    reply({ type: 'result', id: message.id, pdf, diagnostics: output.diagnostics ?? [], ms }, pdf ? [pdf.buffer] : []);
  } catch (error) {
    reply({ type: 'failed', id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
};
