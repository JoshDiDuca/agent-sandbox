// xterm.js filling its area: fits on resize, sends keystrokes, shows the session's output. Terminal text goes only to
// xterm (no HTML); links in it open after a confirmation and clipboard writes (OSC 52) are not handled at all.
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useComputedColorScheme } from '@mantine/core';
import { useEffect, useRef } from 'react';
import { TerminalConnection, type ConnectionState } from './connection';

const DARK = { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3' };
const LIGHT = { background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328', selectionBackground: '#b6d6fd' };

interface TerminalViewProps {
  readonly sessionId: string;
  readonly onState: (state: ConnectionState, detail?: string) => void;
  /** Called with a function that ends the connection (detach). */
  readonly onReady: (detach: () => void) => void;
}

export function TerminalView({ sessionId, onState, onReady }: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  // Dark or light follows the app (which follows the operating system).
  const dark = useComputedColorScheme('dark') === 'dark';
  const startDark = useRef(dark);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const fit = new FitAddon();
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 14,
      cursorBlink: true,
      scrollback: 5000,
      theme: startDark.current ? DARK : LIGHT,
      linkHandler: {
        activate: (_event, uri) => {
          if (!/^https?:\/\//i.test(uri)) return;
          if (window.confirm('Open this link in a new tab?\n\n' + uri.slice(0, 300)))
            window.open(uri, '_blank', 'noopener,noreferrer');
        },
      },
    });
    term.loadAddon(fit);
    term.open(element);
    terminal.current = term;
    fit.fit();

    const connection = new TerminalConnection(sessionId, {
      state: onState,
      output: (bytes) => term.write(bytes),
      reset: () => term.reset(),
    });
    const encoder = new TextEncoder();
    term.onData((text) => connection.send(encoder.encode(text)));
    term.onBinary((text) => connection.send(Uint8Array.from(text, (ch) => ch.charCodeAt(0))));
    term.onResize(({ cols, rows }) => connection.resize(cols, rows));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(element);

    onReady(() => connection.close());
    connection.open(term.cols, term.rows);
    term.focus();
    return () => {
      observer.disconnect();
      connection.close();
      term.dispose();
      terminal.current = null;
    };
  }, [sessionId, onState, onReady]);

  useEffect(() => {
    if (terminal.current) terminal.current.options.theme = dark ? DARK : LIGHT;
  }, [dark]);

  return <div ref={host} className="terminal-host" />;
}
