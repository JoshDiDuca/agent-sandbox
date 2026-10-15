import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { Variant } from './Button';

interface ToastItem {
  readonly id: number;
  readonly text: string;
  readonly variant: Variant;
}

type Notify = (text: string, variant?: Variant) => void;

const ToastContext = createContext<Notify>(() => undefined);

export function useToast(): Notify {
  return useContext(ToastContext);
}

const SHOWN_MS = 6000;
let nextId = 1;

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const notify = useCallback<Notify>(
    (text, variant = 'secondary') => {
      const id = nextId++;
      setItems((all) => [...all.slice(-3), { id, text, variant }]);
      window.setTimeout(() => dismiss(id), SHOWN_MS);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toast-container position-fixed bottom-0 end-0 p-3" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={'toast show align-items-center text-bg-' + t.variant} role="status">
            <div className="d-flex">
              <div className="toast-body">{t.text}</div>
              <button
                type="button"
                className="btn-close btn-close-white me-2 m-auto"
                aria-label="Close"
                onClick={() => dismiss(t.id)}
              />
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
