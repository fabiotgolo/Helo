"use client";

// ——— Sistema central de diálogos da Helo ———
// Substitui os alertas/confirmações NATIVOS do navegador (window.alert/confirm/
// prompt), que quebram a identidade visual e parecem externos ao produto. Toda
// decisão bloqueante passa por aqui: um modal com a UI da Helo (glassmorphism,
// tokens de tema, acessível), aberto de forma assíncrona:
//
//   const dialog = useHeloDialog();
//   const ok = await dialog.confirm({ title, message, confirmLabel, tone });
//   if (!ok) return;
//
// Silencioso por definição: o modal NUNCA fala. Não aciona a voz da plataforma,
// não sobrepõe o Agente Helo nem a voz clonada do paciente — não toca no Audio
// Manager. Mensagens simples e não-bloqueantes devem usar avisos inline/toast,
// não este modal.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRegisterHeloUIActions, type HeloUIAction } from "@/lib/helo-action-registry";

export type HeloDialogTone = "info" | "warning" | "danger" | "error" | "success";

export interface HeloConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: HeloDialogTone;
}

export interface HeloAlertOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  tone?: HeloDialogTone;
}

interface HeloDialogApi {
  confirm: (options: HeloConfirmOptions) => Promise<boolean>;
  alert: (options: HeloAlertOptions) => Promise<void>;
}

const HeloDialogContext = createContext<HeloDialogApi | null>(null);

// Estado interno de um pedido em curso. `resolve` devolve o resultado à
// chamada que aguarda (true/false para confirm; sempre true para alert).
type DialogKind = "confirm" | "alert";
interface DialogRequest {
  kind: DialogKind;
  options: HeloConfirmOptions & HeloAlertOptions;
  resolve: (value: boolean) => void;
}

// Cor do botão principal e do acento por tom. Usa APENAS tokens de tema
// (nunca cor hardcoded) — segue Helo Original, Alto Contraste, Quente, Escuro…
const TONE_ACCENT: Record<HeloDialogTone, string> = {
  info: "text-accent",
  success: "text-sim",
  warning: "text-talvez",
  danger: "text-nao",
  error: "text-nao",
};
const TONE_ICON: Record<HeloDialogTone, string> = {
  info: "ℹ",
  success: "✓",
  warning: "!",
  danger: "⚠",
  error: "⚠",
};
function isDangerTone(tone: HeloDialogTone): boolean {
  return tone === "danger" || tone === "error";
}

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function HeloDialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  // Transição de entrada/saída: `shown` controla as classes; o nó só desmonta
  // ao fim da animação de saída.
  const [shown, setShown] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  // Elemento que tinha o foco antes de abrir — restaurado ao fechar.
  const openerRef = useRef<HTMLElement | null>(null);
  const closeTimer = useRef<number | null>(null);

  const enqueue = useCallback((kind: DialogKind, options: HeloConfirmOptions & HeloAlertOptions) => {
    return new Promise<boolean>((resolve) => {
      openerRef.current = (document.activeElement as HTMLElement) ?? null;
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
      console.log("[HELO DIALOG] open", kind, options.title);
      setRequest({ kind, options, resolve });
    });
  }, []);

  const confirm = useCallback(
    (options: HeloConfirmOptions) => enqueue("confirm", options),
    [enqueue]
  );
  const alert = useCallback(
    (options: HeloAlertOptions) => enqueue("alert", options).then(() => undefined),
    [enqueue]
  );

  // Fecha resolvendo o pedido; anima a saída e só então desmonta e devolve o
  // foco ao elemento que abriu o modal.
  const settle = useCallback((result: boolean) => {
    setRequest((current) => {
      if (!current) return null;
      console.log(result ? "[HELO DIALOG] confirm" : "[HELO DIALOG] cancel");
      current.resolve(result);
      return current; // mantém montado durante a animação de saída
    });
    setShown(false);
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      console.log("[HELO DIALOG] close");
      setRequest(null);
      const opener = openerRef.current;
      openerRef.current = null;
      // Restaura o foco ao gatilho — continuidade para teclado/leitor de tela.
      if (opener && typeof opener.focus === "function") opener.focus();
    }, 160);
  }, []);

  // Entra: dispara a transição no próximo frame e leva o foco ao botão
  // recomendado (o principal).
  useEffect(() => {
    if (!request) return;
    const raf = window.requestAnimationFrame(() => {
      setShown(true);
      confirmBtnRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [request]);

  // Teclado enquanto aberto: Escape cancela; Tab fica preso dentro do modal.
  useEffect(() => {
    if (!request) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        settle(false);
        return;
      }
      if (e.key !== "Tab") return;
      const card = cardRef.current;
      if (!card) return;
      const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.hasAttribute("disabled")
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [request, settle]);

  useEffect(() => {
    return () => {
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    };
  }, []);

  const api = useMemo<HeloDialogApi>(() => ({ confirm, alert }), [confirm, alert]);

  const tone: HeloDialogTone = request?.options.tone ?? "info";
  const isConfirm = request?.kind === "confirm";
  const confirmLabel = request?.options.confirmLabel ?? (isConfirm ? "Continuar" : "Entendi");
  const cancelLabel = request?.options.cancelLabel ?? "Cancelar";
  const danger = isDangerTone(tone);
  const dialogActions = useMemo<HeloUIAction[]>(() => {
    if (!request) return [];
    const title = request.options.title;
    const actions: HeloUIAction[] = [];
    if (isConfirm) {
      actions.push({
        actionId: "dialog.cancel",
        label: `${cancelLabel} — ${title}`,
        aliases: [
          cancelLabel,
          cancelLabel.toLowerCase(),
          "não",
          "nao",
          "clicar não",
          "clicar em não",
          "clique em não",
          "cancelar",
          "manter aberto",
        ],
        type: "navigation",
        enabled: true,
        run: () => settle(false),
        toolSuccess: { result: "handled", dialog: "closed", value: false, suppressAssistantNarration: true },
      });
    }
    actions.push({
      actionId: "dialog.confirm",
      label: `${confirmLabel} — ${title}`,
      aliases: [
        confirmLabel,
        confirmLabel.toLowerCase(),
        "sim",
        "clicar sim",
        "clicar em sim",
        "clique em sim",
        "confirmar",
        "continuar",
      ],
      type: "navigation",
      enabled: true,
      run: () => settle(true),
      toolSuccess: { result: "handled", dialog: "closed", value: true, suppressAssistantNarration: true },
    });
    return actions;
  }, [cancelLabel, confirmLabel, isConfirm, request, settle]);
  useRegisterHeloUIActions(dialogActions);

  return (
    <HeloDialogContext.Provider value={api}>
      {children}
      {request && (
        <div
          // Overlay escuro translúcido com blur — o produto continua perceptível
          // ao fundo, sem a cara nativa do navegador.
          className={`fixed inset-0 z-[100] flex items-center justify-center p-4 transition-opacity duration-150 ease-out motion-reduce:transition-none ${
            shown ? "opacity-100" : "opacity-0"
          }`}
        >
          <div
            aria-hidden="true"
            onClick={() => settle(false)}
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
          />
          <div
            ref={cardRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="helo-dialog-title"
            aria-describedby={request.options.message ? "helo-dialog-desc" : undefined}
            className={`relative w-full max-w-md rounded-3xl border border-line bg-surface-elevated/95 p-6 shadow-lift backdrop-blur-xl transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none sm:p-7 ${
              shown ? "translate-y-0 opacity-100 scale-100" : "translate-y-2 opacity-0 scale-[0.98]"
            }`}
          >
            <div className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full border border-line text-lg font-semibold ${TONE_ACCENT[tone]}`}
              >
                {TONE_ICON[tone]}
              </span>
              <div className="min-w-0 flex-1">
                <h2
                  id="helo-dialog-title"
                  className="text-xl font-semibold tracking-tight text-ink"
                >
                  {request.options.title}
                </h2>
                {request.options.message && (
                  <p
                    id="helo-dialog-desc"
                    className="mt-2 max-h-[50vh] overflow-y-auto text-base leading-relaxed text-ink-soft"
                  >
                    {request.options.message}
                  </p>
                )}
              </div>
            </div>

            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              {isConfirm && (
                <button
                  type="button"
                  onClick={() => settle(false)}
                  className="min-h-11 rounded-full border border-line bg-transparent px-6 py-2.5 text-base font-medium text-ink transition-colors hover:border-ink-mute"
                >
                  {cancelLabel}
                </button>
              )}
              <button
                ref={confirmBtnRef}
                type="button"
                onClick={() => settle(true)}
                className={`min-h-11 rounded-full px-6 py-2.5 text-base font-semibold shadow-soft transition-colors ${
                  danger
                    ? "bg-nao text-white hover:opacity-90"
                    : "bg-accent text-on-accent hover:bg-accent-strong"
                }`}
              >
                {confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </HeloDialogContext.Provider>
  );
}

export function useHeloDialog(): HeloDialogApi {
  const ctx = useContext(HeloDialogContext);
  if (!ctx) throw new Error("useHeloDialog precisa estar dentro de <HeloDialogProvider>");
  return ctx;
}
