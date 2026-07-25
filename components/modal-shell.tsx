"use client";

import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';

/**
 * Shared modal frame for route-aware Helo surfaces.  It intentionally uses the
 * app's semantic tokens so every active theme applies to dialogs as well.
 */
export function ModalShell({
  children,
  onClose,
  label,
  labelledBy,
  describedBy,
  role = "dialog",
  disableDismiss = false,
  className = "",
}: {
  children: ReactNode;
  onClose: () => void;
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  role?: "dialog" | "alertdialog";
  disableDismiss?: boolean;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const disableDismissRef = useRef(disableDismiss);
  onCloseRef.current = onClose;
  disableDismissRef.current = disableDismiss;

  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    focusable?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !disableDismissRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      openerRef.current?.focus();
    };
  }, []);

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-[modal-fade-in_200ms_ease-out]">
      <div
        aria-hidden="true"
        onClick={disableDismiss ? undefined : onClose}
        className="absolute inset-0 z-0"
      />
      <div
        ref={dialogRef}
        role={role}
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        className={`relative z-10 w-[90vw] max-w-lg rounded-3xl border border-line bg-surface-elevated/95 p-6 font-sans text-ink shadow-2xl shadow-black/50 backdrop-blur-xl animate-[modal-scale-in_200ms_ease-out] sm:p-8 ${className}`}
      >
        {children}
      </div>
    </div>
  );
}
