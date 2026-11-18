/**
 * Where the time of one compile goes, from the click on Recompile to the first PDF page on screen. The browser
 * stamps its own steps; the server reports what happened between receiving the request and answering it.
 */
export type CompileMarks = {
  /** Recompile was clicked. */
  click: number;
  /** Files hashed and the request built. */
  prepared?: number;
  /** The response headers arrived. */
  answered?: number;
  /** The response body was read and parsed. */
  received?: number;
  /** pdf.js opened the document. */
  opened?: number;
  /** The first page was drawn. */
  painted?: number;
};
export type ServerTimings = {
  receive?: number;
  queue?: number;
  sync?: number;
  compiler?: number;
  read?: number;
  total?: number;
  passes?: number;
  preamble?: number;
};
export type Segment = { label: string; ms: number; note?: string };

const span = (from?: number, to?: number) =>
  from === undefined || to === undefined ? null : Math.max(0, Math.round(to - from));

/** The compile split into consecutive segments that add up to `total`; steps that have not happened are left out. */
export function compileSegments(marks: CompileMarks, server: ServerTimings = {}) {
  const segments: Segment[] = [];
  const add = (label: string, ms: number | null | undefined, note?: string) => {
    if (ms !== null && ms !== undefined) segments.push({ label, ms, ...(note ? { note } : {}) });
  };
  add('Prepare files in the browser', span(marks.click, marks.prepared), 'hash the files, send only changed ones');
  const request = span(marks.prepared, marks.answered);
  if (request !== null) {
    const onServer = server.total ?? 0;
    // What the round trip took beyond the server's own time: upload, proxy and network latency.
    add('Network and upload', Math.max(0, request - onServer));
    add('Server: receive and check the request', server.receive);
    add('Server: wait for other compiles', server.queue);
    add('Server: write changed files', server.sync);
    add('Compiler time', server.compiler);
    add('Server: read the PDF and log', server.read);
    const counted =
      (server.receive ?? 0) + (server.queue ?? 0) + (server.sync ?? 0) + (server.compiler ?? 0) + (server.read ?? 0);
    if (onServer - counted > 0) add('Server: other', onServer - counted);
  }
  add('Download the result', span(marks.answered, marks.received));
  add('Open the PDF', span(marks.received, marks.opened));
  add('Draw the first page', span(marks.opened, marks.painted));
  const end = marks.painted ?? marks.opened ?? marks.received ?? marks.answered;
  return { segments, total: span(marks.click, end) ?? 0, complete: marks.painted !== undefined };
}

export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
