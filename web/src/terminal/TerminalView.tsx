// xterm.js filling its area: fits on resize, sends keystrokes, shows the session's output. Terminal text goes only to
// xterm (no HTML); links in it open after a confirmation and clipboard writes (OSC 52) are not handled at all.
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { currentTheme } from '../theme';
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

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const fit = new FitAddon();
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 14,
      cursorBlink: true,
      scrollback: 5000,
      theme: currentTheme() === 'dark' ? DARK : LIGHT,
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
    const colors = window.matchMedia('(prefers-color-scheme: dark)');
    const recolor = (): void => {
      term.options.theme = currentTheme() === 'dark' ? DARK : LIGHT;
    };
    colors.addEventListener('change', recolor);

    onReady(() => connection.close());
    connection.open(term.cols, term.rows);
    term.focus();
    return () => {
      colors.removeEventListener('change', recolor);
      observer.disconnect();
      connection.close();
      term.dispose();
    };
  }, [sessionId, onState, onReady]);

  return <div ref={host} className="terminal-host" />;
}
