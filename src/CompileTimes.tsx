import { compileSegments, seconds, type CompileMarks, type ServerTimings } from './lib/compileTrace';

/**
 * The log dialog's timing section: the whole wait from Recompile to the PDF on screen, split into its steps.
 * Without a trace (a failed compile, or a result loaded from the server) only the server's time is known.
 */
export function CompileTimes({
  trace,
  serverMs,
}: {
  trace: { marks: CompileMarks; server: ServerTimings; browser?: boolean } | null;
  serverMs: number;
}) {
  if (!trace)
    return (
      <p className="muted compile-timings">
        Time on the server: {seconds(serverMs)}. The time to send the files and show the PDF is not included.
      </p>
    );
  const { segments, total, complete } = compileSegments(trace.marks, trace.server, trace.browser);
  return (
    <div className="compile-timings">
      <p className="muted">
        <strong data-testid="compile-total">{seconds(total)}</strong>{' '}
        {trace.browser
          ? 'from your last edit to the PDF on screen'
          : complete
            ? 'from Recompile to the PDF on screen'
            : 'from Recompile to the result (the PDF is not shown yet)'}
        {trace.server.compiler !== undefined && <>, of which compiler time {seconds(trace.server.compiler)}</>}.
      </p>
      <table className="timing-table">
        <tbody>
          {segments.map((segment) => (
            <tr key={segment.label}>
              <th scope="row">
                {segment.label}
                {segment.note && <span> ({segment.note})</span>}
              </th>
              <td>{segment.ms.toLocaleString()} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
