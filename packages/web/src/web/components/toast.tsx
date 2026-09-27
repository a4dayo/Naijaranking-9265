import { createContext, useCallback, useContext, useMemo, useState } from "react";

type Tone = "default" | "success" | "error";
interface Toast {
  id: number;
  message: string;
  tone: Tone;
}

const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => undefined);

/** Minimal toast stack — vote moves, verification, admin acts all report here. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: Tone = "default") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-2), { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 4200);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-100 flex flex-col items-center gap-2 px-4">
        {toasts.map((toast) => (
          <output
            key={toast.id}
            className={[
              "nr-rise pointer-events-auto max-w-sm rounded-xl border px-4 py-2.5 text-sm font-medium shadow-lg backdrop-blur",
              toast.tone === "success"
                ? "border-primary/30 bg-primary text-primary-foreground"
                : toast.tone === "error"
                  ? "border-destructive/30 bg-destructive text-white"
                  : "border-border bg-card text-card-foreground",
            ].join(" ")}
          >
            {toast.message}
          </output>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
