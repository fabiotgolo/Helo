"use client";

// ——— Player de Atividades: o MODO DE USO das sessões personalizadas ———
// Renderiza o snapshot de uma execução (run) item a item, registra a
// resposta observada (opção) e o gesto do paciente SEPARADAMENTE, e nunca
// oferece edição — o modo de edição vive em /atividades/gerenciar.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContextualEdit } from "@/components/contextual-edit";
import type { Gesture } from "@/lib/types";
import { useHelo } from "@/lib/helo-state";
import { useGestures } from "@/lib/gestures";
import {
  BARE_QUESTION_OPTION_ID,
  isQuestionItem,
  youtubeEmbedUrl,
  type ActivityItem,
  type ActivityMedia,
  type ActivityOption,
  type ActivityRun,
} from "@/lib/activity-types";

// Cada alternativa é uma proposição de sim/talvez/não — o paciente da Helo
// só comunica pelos três gestos, nunca "seleciona". Por isso cada opção
// carrega seus próprios 👍✋✊.
const GESTURE_ORDER: Gesture[] = ["sim", "talvez", "nao"];

const GESTURE_ON: Record<Gesture, string> = {
  sim: "border-sim bg-sim-soft text-sim",
  talvez: "border-talvez bg-talvez-soft text-talvez",
  nao: "border-nao bg-nao-soft text-nao",
};

/** Fonte da imagem: biblioteca interna (rota autorizada) ou URL externa. */
export function mediaSrc(m: ActivityMedia, patientId: number): string | null {
  if (m.mediaId) return `/api/media?patientId=${patientId}&id=${m.mediaId}`;
  return m.url;
}

function ImageView({
  src,
  caption,
  onZoom,
}: {
  src: string;
  caption: string | null;
  onZoom: (src: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <figure className="flex h-40 w-full max-w-md flex-col items-center justify-center gap-1 rounded-2xl border border-line bg-cream text-sm text-ink-mute">
        <span aria-hidden="true">🖼️</span>
        Imagem indisponível
      </figure>
    );
  }
  return (
    <figure className="flex min-w-0 flex-col items-center gap-1.5">
      <button
        type="button"
        onClick={() => onZoom(src)}
        className="group rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        aria-label={caption ? `Ampliar imagem: ${caption}` : "Ampliar imagem"}
      >
        {/* mídia do paciente é dinâmica e autorizada por cookie — <img> direto */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={caption ?? "Imagem da atividade"}
          loading="lazy"
          onError={() => setFailed(true)}
          className="max-h-[36vh] w-auto max-w-full rounded-2xl object-contain shadow-soft transition-transform group-hover:scale-[1.01]"
        />
      </button>
      {caption && (
        <figcaption className="max-w-md text-center text-sm text-ink-soft">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}

function YoutubeView({ media }: { media: ActivityMedia }) {
  const embed = media.url ? youtubeEmbedUrl(media.url) : null;
  if (!embed) {
    return (
      <div className="flex h-32 w-full max-w-xl items-center justify-center rounded-2xl border border-line bg-cream text-sm text-ink-mute">
        Vídeo indisponível — link do YouTube inválido.
      </div>
    );
  }
  return (
    <div className="w-full max-w-xl">
      <div className="aspect-video w-full overflow-hidden rounded-2xl shadow-soft">
        <iframe
          src={embed}
          title={media.caption ?? "Vídeo da atividade"}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          className="h-full w-full border-0"
        />
      </div>
      {media.caption && (
        <p className="mt-1.5 text-center text-sm text-ink-soft">{media.caption}</p>
      )}
    </div>
  );
}

/** Galeria de mídia de um item — imagens (com ampliação) e YouTube. */
export function ActivityMediaView({
  media,
  patientId,
}: {
  media: ActivityMedia[];
  patientId: number;
}) {
  const [zoom, setZoom] = useState<string | null>(null);
  if (media.length === 0) return null;
  return (
    <>
      <div className="flex w-full flex-wrap items-start justify-center gap-4">
        {media.map((m, i) => {
          if (m.kind === "youtube") return <YoutubeView key={i} media={m} />;
          const src = mediaSrc(m, patientId);
          if (!src) return null;
          return <ImageView key={i} src={src} caption={m.caption} onZoom={setZoom} />;
        })}
      </div>
      {zoom && (
        <div
          role="dialog"
          aria-label="Imagem ampliada"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
          onClick={() => setZoom(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={zoom}
            alt="Imagem ampliada"
            className="max-h-full max-w-full rounded-xl object-contain"
          />
          <button
            type="button"
            onClick={() => setZoom(null)}
            aria-label="Fechar imagem ampliada"
            className="absolute right-4 top-4 rounded-full bg-white/90 px-4 py-2 text-sm font-medium"
          >
            ✕ Fechar
          </button>
        </div>
      )}
    </>
  );
}

/** Apresentação do item (título, mídia, texto, pergunta) — sem registro. */
function ItemPresentation({
  item,
  patientId,
}: {
  item: ActivityItem;
  patientId: number;
}) {
  return (
    <div className="flex w-full flex-col items-center gap-5">
      {item.title && (
        <h2 className="text-center text-2xl font-medium tracking-tight sm:text-3xl">
          {item.title}
        </h2>
      )}
      <ActivityMediaView media={item.media} patientId={patientId} />
      {item.text && (
        <p className="max-w-2xl text-center text-lg leading-relaxed text-ink-soft">
          {item.text}
        </p>
      )}
      {isQuestionItem(item) && (
        <p className="max-w-2xl text-center text-3xl font-medium leading-snug tracking-tight sm:text-4xl">
          {item.question}
        </p>
      )}
    </div>
  );
}

/** Botões de gesto de UMA alternativa (o operador marca o sinal do paciente). */
function OptionGestures({
  option,
  current,
  onPick,
  disabled,
}: {
  option: ActivityOption;
  current: Gesture | null;
  onPick: (g: Gesture) => void;
  disabled?: boolean;
}) {
  const gestures = useGestures();
  const answered = current != null;
  return (
    <div
      className={`flex w-full flex-col gap-2 rounded-3xl border px-4 py-3 transition-colors sm:flex-row sm:items-center sm:justify-between ${
        answered ? "border-ink-mute bg-card" : "border-line/70 bg-card/80 backdrop-blur-md"
      }`}
    >
      <span className="text-center text-xl font-medium tracking-tight sm:text-left">
        {option.label}
      </span>
      <div
        role="group"
        aria-label={`Gesto do paciente para: ${option.label}`}
        className="flex items-center justify-center gap-2"
      >
        {GESTURE_ORDER.map((g) => {
          const on = current === g;
          return (
            <button
              key={g}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              aria-label={`${gestures[g].label} para ${option.label}`}
              onClick={() => onPick(g)}
              className={`flex h-14 w-14 items-center justify-center rounded-2xl border text-2xl transition-transform active:scale-95 disabled:opacity-50 ${
                on ? GESTURE_ON[g] : "border-line bg-cream/60 opacity-70 hover:opacity-100"
              }`}
            >
              <span aria-hidden="true">{gestures[g].emoji}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Item da sessão, sem interação de registro — usado pela pré-visualização
 * do editor. Mostra cada alternativa com os três gestos esmaecidos, para o
 * profissional ver o layout que o operador terá.
 */
export function ActivityItemView({
  item,
  patientId,
}: {
  item: ActivityItem;
  patientId: number;
}) {
  const gestures = useGestures();
  return (
    <div className="flex w-full flex-col items-center gap-5">
      <ItemPresentation item={item} patientId={patientId} />
      {isQuestionItem(item) && item.options.length > 0 && (
        <div className="flex w-full max-w-md flex-col gap-3">
          {item.options.map((o) => (
            <div
              key={o.id}
              className="flex flex-col gap-2 rounded-3xl border border-line/70 bg-card/80 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <span className="text-center text-xl font-medium tracking-tight sm:text-left">
                {o.label}
              </span>
              <div className="flex items-center justify-center gap-2 opacity-50">
                {GESTURE_ORDER.map((g) => (
                  <span key={g} className="text-2xl" aria-hidden="true">
                    {gestures[g].emoji}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ——— Player da sessão ———

type ItemAnswers = Record<string, Gesture>; // optionId → gesto

export function SessionPlayer({
  run,
  patientId,
  onExit,
  initialItemId = null,
  canEdit = false,
}: {
  run: ActivityRun;
  patientId: number;
  /** Chamado ao encerrar (concluída ou saída manual). */
  onExit: (summary: { status: "concluida" | "abandonada"; respondidos: number; total: number }) => void;
  /** Abre a sessão já neste item (retomada pós-edição contextual). */
  initialItemId?: string | null;
  /** Exibe a ação contextual "Editar este item" (capacidade do servidor). */
  canEdit?: boolean;
}) {
  const { speak, stop } = useHelo();
  const items = useMemo(
    () => [...run.items].sort((a, b) => a.order - b.order),
    [run.items]
  );
  const [idx, setIdx] = useState(() => {
    if (!initialItemId) return 0;
    const i = items.findIndex((it) => it.id === initialItemId);
    return i >= 0 ? i : 0;
  });
  // answers[itemId][optionId] = gesto observado do paciente naquela opção.
  const [answers, setAnswers] = useState<Record<string, ItemAnswers>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Tempo até o PRIMEIRO gesto de cada item (reação inicial).
  const firstGestureAt = useRef<Record<string, number>>({});
  const shownAt = useRef(0);
  const finishedRef = useRef(false);
  // Salvamentos serializados por item: cada toque envia o mapa COMPLETO
  // atual; a fila garante que o último estado é o que fica gravado.
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);

  const item = items[idx];
  const isQuestion = item ? isQuestionItem(item) : false;
  const itemAnswers = item ? answers[item.id] : undefined;
  const questionItems = items.filter(isQuestionItem);
  const respondidos = Object.keys(answers).filter(
    (id) => Object.keys(answers[id] ?? {}).length > 0
  ).length;

  // A pergunta é fala da PLATAFORMA (speakerRole padrão do orquestrador) —
  // nunca atribuída ao paciente.
  useEffect(() => {
    if (!item) return;
    shownAt.current = Date.now();
    setSaveError(null);
    if (isQuestionItem(item)) void speak(item.question);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, run.id]);

  const endRun = useCallback(
    (status: "concluida" | "abandonada", keepalive = false) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      void fetch("/api/activities/runs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientId, runId: run.id, status }),
        keepalive,
      }).catch(() => {});
    },
    [patientId, run.id]
  );

  // Sessão interrompida (troca de página, fechamento) → abandonada, com
  // keepalive — nunca fica "em andamento" para sempre em silêncio.
  // O abandono na desmontagem é ADIADO e cancelado se o efeito remontar:
  // o ciclo montar→limpar→remontar do StrictMode (dev) não pode encerrar
  // uma sessão que acabou de começar.
  const abortTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (abortTimer.current) {
      clearTimeout(abortTimer.current);
      abortTimer.current = null;
    }
    const abort = () => endRun("abandonada", true);
    window.addEventListener("beforeunload", abort);
    return () => {
      window.removeEventListener("beforeunload", abort);
      abortTimer.current = setTimeout(abort, 300);
      stop();
    };
  }, [endRun, stop]);

  // Marca o gesto do paciente para UMA alternativa e persiste o mapa
  // completo do item. Re-tocar corrige livremente — a correção é explícita
  // e nunca silenciosa (o servidor sobe a revisão).
  const pick = useCallback(
    (optionId: string, g: Gesture) => {
      if (!item) return;
      const itemId = item.id;
      if (firstGestureAt.current[itemId] == null) {
        firstGestureAt.current[itemId] = Date.now() - shownAt.current;
      }
      const nextMap: ItemAnswers = { ...(answers[itemId] ?? {}), [optionId]: g };
      setAnswers((prev) => ({ ...prev, [itemId]: nextMap }));
      setSaveError(null);
      pending.current += 1;
      setSaving(true);
      const payload = {
        patientId,
        runId: run.id,
        itemId,
        optionGestures: Object.entries(nextMap).map(([oid, ges]) => ({
          optionId: oid,
          gesture: ges,
        })),
        responseTimeMs: firstGestureAt.current[itemId],
      };
      saveChain.current = saveChain.current
        .then(async () => {
          const r = await fetch("/api/activities/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!r.ok) {
            const d = (await r.json().catch(() => null)) as { error?: string } | null;
            throw new Error(d?.error ?? "falha ao salvar");
          }
        })
        .catch((e: Error) => setSaveError(e.message))
        .finally(() => {
          pending.current -= 1;
          if (pending.current === 0) setSaving(false);
        });
    },
    [item, answers, patientId, run.id]
  );

  const finish = useCallback(() => {
    endRun("concluida");
    stop();
    onExit({ status: "concluida", respondidos, total: questionItems.length });
  }, [endRun, stop, onExit, respondidos, questionItems.length]);

  const leave = useCallback(() => {
    endRun("abandonada");
    stop();
    onExit({ status: "abandonada", respondidos, total: questionItems.length });
  }, [endRun, stop, onExit, respondidos, questionItems.length]);

  if (!item) return null;
  const last = idx === items.length - 1;
  const showGestures = isQuestion || item.gesturesEnabled;
  const hasOptions = item.options.length > 0;
  const itemAnswered = itemAnswers && Object.keys(itemAnswers).length > 0;

  return (
    <section
      aria-label={`Sessão: ${run.templateTitle}`}
      className="fade-rise pointer-events-auto mx-auto flex w-full max-w-3xl flex-col items-center gap-6 px-4 py-6"
    >
      <header className="flex w-full flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold uppercase tracking-widest text-ink-soft">
            {run.templateTitle}
          </p>
          <p className="text-xs text-ink-mute">
            {idx + 1} de {items.length}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Edição contextual do ITEM em exibição: abre Gerenciar já nesta
              questão. Sair encerra esta sessão (abandonada — o snapshot é
              imutável); o retorno recomeça a atividade neste mesmo item, já
              com o conteúdo novo. */}
          {canEdit && (
            <ContextualEdit
              target={{
                entityType: "activity",
                activityId: run.templateId,
                itemId: item.id,
              }}
              source={`/atividades?start=${run.templateId}&item=${item.id}`}
              label={`item ${idx + 1} de ${run.templateTitle}`}
              onNavigate={() =>
                window.confirm(
                  "Editar este item encerra a sessão atual (as respostas já registradas são preservadas). Depois de salvar, você volta direto a este item. Continuar?"
                )
              }
            />
          )}
          <button
            type="button"
            onClick={leave}
            className="rounded-full border border-line bg-card px-4 py-2 text-sm font-medium hover:border-ink-mute"
          >
            Encerrar sessão
          </button>
        </div>
      </header>

      <div key={item.id} className="fade-rise flex w-full flex-col items-center gap-5">
        <ItemPresentation item={item} patientId={patientId} />

        {showGestures && hasOptions && (
          <div className="flex w-full max-w-md flex-col gap-3">
            <p className="text-center text-sm text-ink-soft">
              Toque no gesto que o paciente fez em cada alternativa.
            </p>
            {item.options.map((o) => (
              <OptionGestures
                key={o.id}
                option={o}
                current={itemAnswers?.[o.id] ?? null}
                onPick={(g) => pick(o.id, g)}
              />
            ))}
          </div>
        )}

        {/* Pergunta sem alternativas: gesto único sobre a própria pergunta. */}
        {showGestures && !hasOptions && isQuestion && (
          <OptionGestures
            option={{ id: BARE_QUESTION_OPTION_ID, label: "Resposta do paciente" }}
            current={itemAnswers?.[BARE_QUESTION_OPTION_ID] ?? null}
            onPick={(g) => pick(BARE_QUESTION_OPTION_ID, g)}
          />
        )}

        {showGestures && (
          <div className="flex min-h-6 flex-col items-center gap-1 text-sm">
            {saving && <span className="text-ink-mute">Registrando…</span>}
            {saveError && (
              <span role="alert" className="text-nao">
                {saveError} — toque no gesto de novo para tentar outra vez.
              </span>
            )}
            {!saving && !saveError && itemAnswered && (
              <span className="text-ink-soft">✓ Registrado</span>
            )}
          </div>
        )}
      </div>

      <nav className="flex w-full items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setIdx((i) => Math.max(0, i - 1))}
          disabled={idx === 0}
          className="min-h-12 rounded-full border border-line bg-card px-6 py-2.5 font-medium disabled:opacity-40"
        >
          ← Anterior
        </button>
        {last ? (
          <button
            type="button"
            onClick={finish}
            className="min-h-12 rounded-full bg-accent px-8 py-2.5 font-medium text-on-accent hover:bg-accent-strong"
          >
            Concluir sessão
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setIdx((i) => Math.min(items.length - 1, i + 1))}
            className="min-h-12 rounded-full bg-accent px-8 py-2.5 font-medium text-on-accent hover:bg-accent-strong"
          >
            Próximo →
          </button>
        )}
      </nav>
    </section>
  );
}
