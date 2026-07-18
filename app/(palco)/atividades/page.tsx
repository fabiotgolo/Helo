"use client";

// ——— Modo Atividades: sessões personalizadas do paciente ativo ———
// MODO DE USO apenas: lista as atividades ATIVAS do paciente e executa
// sessões. Criar/editar vive em /atividades/gerenciar (modo de edição) —
// nada aqui altera conteúdo, evitando edição acidental durante a sessão.
//
// O palco dos orbes persiste por baixo (layout do grupo (palco)); o
// conteúdo flutua em overlay, como Rotina e Conversa.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePatient } from "@/lib/patient";
import { redirectToLogin } from "@/lib/use-auth";
import { OverlayVeil } from "@/components/overlay-panel";
import { SessionPlayer } from "@/components/activity-player";
import { ContextualEdit } from "@/components/contextual-edit";
import { buildEditLink, readSearchParams } from "@/lib/edit-link";
import { useRegisterHeloUIActions, type HeloUIAction } from "@/lib/helo-action-registry";
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_CATEGORY_LABELS,
  type ActivityCaps,
  type ActivityRun,
  type ActivityTemplate,
} from "@/lib/activity-types";

type View =
  | { kind: "lista" }
  | { kind: "sessao"; run: ActivityRun; initialItemId: string | null }
  | { kind: "fim"; titulo: string; respondidos: number; total: number };

export default function AtividadesPage() {
  const router = useRouter();
  const { patient, patientId } = usePatient();
  const [templates, setTemplates] = useState<ActivityTemplate[] | null>(null);
  const [caps, setCaps] = useState<ActivityCaps | null>(null);
  const [state, setState] = useState<"ok" | "carregando" | "negado" | "erro">(
    "carregando"
  );
  const [view, setView] = useState<View>({ kind: "lista" });
  const [starting, setStarting] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  // Retomada pós-edição contextual: ?start=<templateId>&item=<itemId> inicia
  // uma NOVA sessão da atividade (o snapshot é imutável — só uma sessão nova
  // exibe o conteúdo recém-salvo) já posicionada no item que estava em uso.
  const [resumeCtx, setResumeCtx] = useState<{
    templateId: string;
    itemId: string | null;
  } | null>(null);
  // Lido num efeito (não no initializer): na navegação client-side a URL só
  // é confiável depois da montagem da rota.
  useEffect(() => {
    const q = readSearchParams();
    const templateId = q.get("start");
    if (templateId) setResumeCtx({ templateId, itemId: q.get("item") });
  }, []);

  // Carga isolada por paciente: troca rápida descarta respostas antigas.
  useEffect(() => {
    if (patientId == null) return;
    let stale = false;
    setState("carregando");
    setTemplates(null);
    setView({ kind: "lista" });
    void fetch(`/api/activities?patientId=${patientId}`)
      .then(async (r) => {
        if (stale) return;
        if (r.status === 401) {
          redirectToLogin();
          return;
        }
        if (r.status === 403) {
          setState("negado");
          return;
        }
        if (!r.ok) throw new Error();
        const d = (await r.json()) as {
          templates: ActivityTemplate[];
          caps: ActivityCaps;
        };
        if (stale) return;
        setTemplates(d.templates);
        setCaps(d.caps);
        setState("ok");
      })
      .catch(() => {
        if (!stale) setState("erro");
      });
    return () => {
      stale = true;
    };
  }, [patientId]);

  const start = useCallback(
    async (template: ActivityTemplate, initialItemId: string | null = null) => {
      console.log("[HELO ACTIVITY] open requested");
      console.log("[HELO ACTIVITY] activity title", template.title);
      console.log("[HELO ACTIVITY] activity id", template.id);
      if (patientId == null || starting) return;
      console.log("[HELO ACTIVITY] activity found — opening session");
      setStarting(template.id);
      setStartError(null);
      try {
        const r = await fetch("/api/activities/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patientId, templateId: template.id }),
        });
        const d = (await r.json().catch(() => null)) as
          | { run?: ActivityRun; error?: string }
          | null;
        if (!r.ok || !d?.run) {
          throw new Error(d?.error ?? "não foi possível iniciar a sessão");
        }
        setView({ kind: "sessao", run: d.run, initialItemId });
      } catch (e) {
        setStartError((e as Error).message);
      } finally {
        setStarting(null);
      }
    },
    [patientId, starting]
  );

  // Consome o deep link de retomada UMA vez, quando a lista chega: inicia a
  // sessão da atividade editada já no item de onde o usuário saiu. A URL é
  // limpa em seguida — encerrar a sessão volta à lista, sem reiniciar.
  useEffect(() => {
    if (!resumeCtx || state !== "ok" || !templates || !caps?.run) return;
    const template = templates.find((t) => t.id === resumeCtx.templateId);
    setResumeCtx(null);
    window.history.replaceState(null, "", "/atividades");
    if (template) void start(template, resumeCtx.itemId);
  }, [resumeCtx, state, templates, caps, start]);

  // Action Registry da LISTA: iniciar cada sessão (com a permissão real de
  // execução) e a edição contextual. Dentro de uma sessão, quem registra as
  // ações é o SessionPlayer; na tela de fim, voltar à lista.
  const registryActions = useMemo<HeloUIAction[]>(() => {
    if (view.kind === "fim") {
      return [{
        actionId: "atividades.voltarLista",
        label: "Voltar às atividades",
        type: "activity",
        enabled: true,
        run: () => setView({ kind: "lista" }),
      }];
    }
    if (view.kind !== "lista" || state !== "ok" || !templates) return [];
    const list: HeloUIAction[] = [];
    // Navegação sempre visível na lista (inclusive no estado vazio, quando
    // são os ÚNICOS botões da tela): mesmos destinos dos links reais.
    if (caps?.create || caps?.edit) {
      list.push({
        actionId: "atividades.gerenciar",
        label: "Gerenciar atividades",
        type: "activity",
        enabled: true,
        run: () => router.push("/atividades/gerenciar"),
      });
    }
    if (caps?.create) {
      list.push({
        actionId: "atividades.criar",
        label: "Criar sessão",
        type: "activity",
        enabled: true,
        requiredPermission: "createActivities",
        run: () => router.push("/atividades/gerenciar"),
      });
    }
    for (const t of templates) {
      list.push({
        // Id estável baseado no ID REAL da atividade — nunca no texto visual
        // (editável). Toda atividade criada em Gerenciar entra aqui
        // automaticamente; o label casa com o card. Abrir por tool executa o
        // MESMO handler do clique manual (start), abrindo a sessão de verdade.
        actionId: `atividades.iniciar.${t.id}`,
        label: t.title,
        type: "activity",
        enabled: Boolean(caps?.run) && starting == null,
        requiredPermission: "runActivities",
        run: () => void start(t),
      });
      if (caps?.edit) {
        list.push({
          actionId: `atividades.editar.${t.id}`,
          label: `Editar ${t.title}`,
          type: "edit",
          enabled: true,
          requiredPermission: "editActivities",
          run: () => router.push(buildEditLink({ entityType: "activity", activityId: t.id }, "/atividades")),
        });
      }
    }
    console.log("[HELO ACTIVITY] menu actions registered", list.length);
    return list;
  }, [caps, router, start, starting, state, templates, view]);
  useRegisterHeloUIActions(registryActions);

  if (patientId == null) {
    return (
      <Shell>
        <p className="text-center text-ink-soft">Carregando o paciente…</p>
      </Shell>
    );
  }

  if (view.kind === "sessao") {
    return (
      <div className="relative flex flex-1 flex-col">
        <OverlayVeil />
        <main className="relative flex w-full flex-1 flex-col items-center px-0 pb-6">
          <SessionPlayer
            run={view.run}
            patientId={patientId}
            initialItemId={view.initialItemId}
            canEdit={Boolean(caps?.edit)}
            onGoToMenu={() => setView({ kind: "lista" })}
            onExit={({ status, respondidos, total }) =>
              setView(
                status === "concluida"
                  ? {
                      kind: "fim",
                      titulo: view.run.templateTitle,
                      respondidos,
                      total,
                    }
                  : { kind: "lista" }
              )
            }
          />
        </main>
      </div>
    );
  }

  if (view.kind === "fim") {
    return (
      <Shell>
        <section
          aria-label="Sessão concluída"
          className="flex flex-col items-center gap-5 text-center"
        >
          <p className="text-sm font-semibold uppercase tracking-widest text-ink-soft">
            Sessão concluída
          </p>
          <h1 className="text-3xl font-medium tracking-tight">{view.titulo}</h1>
          {view.total > 0 && (
            <p className="text-lg text-ink-soft">
              {view.respondidos} de {view.total}{" "}
              {view.total === 1 ? "pergunta registrada" : "perguntas registradas"}.
            </p>
          )}
          <p className="max-w-md text-sm text-ink-mute">
            Os registros são observacionais e ficam no Dashboard do paciente.
          </p>
          <button
            type="button"
            onClick={() => setView({ kind: "lista" })}
            className="rounded-full bg-accent px-8 py-3 font-medium text-on-accent hover:bg-accent-strong"
          >
            Voltar às atividades
          </button>
        </section>
      </Shell>
    );
  }

  // ——— Lista ———
  return (
    <Shell>
      <div className="text-center">
        <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">Atividades</h1>
        <p className="mt-2 text-lg text-ink-soft">
          Sessões personalizadas de {patient?.name ?? "…"} — memórias,
          reconhecimento, treino e exercícios.
        </p>
      </div>

      {(caps?.create || caps?.edit) && (
        <div className="flex justify-center">
          <Link
            href="/atividades/gerenciar"
            className="rounded-full border border-line bg-card px-5 py-2.5 text-sm font-medium hover:border-ink-mute"
          >
            ⚙ Gerenciar atividades
          </Link>
        </div>
      )}

      {state === "carregando" && (
        <p className="text-center text-ink-mute">Carregando as atividades…</p>
      )}

      {state === "negado" && (
        <p role="alert" className="mx-auto max-w-md text-center text-ink-soft">
          Você não tem permissão para ver as Atividades deste paciente. Fale
          com o administrador.
        </p>
      )}

      {state === "erro" && (
        <p role="alert" className="mx-auto max-w-md text-center text-ink-soft">
          Não foi possível carregar as atividades. Verifique a conexão e tente
          de novo.
        </p>
      )}

      {state === "ok" && templates && templates.length === 0 && (
        <div className="flex flex-col items-center gap-4 py-6 text-center">
          <p className="text-ink-soft">Nenhuma sessão personalizada criada ainda.</p>
          {caps?.create && (
            <Link
              href="/atividades/gerenciar"
              className="rounded-full bg-accent px-6 py-3 font-medium text-on-accent hover:bg-accent-strong"
            >
              Criar sessão
            </Link>
          )}
        </div>
      )}

      {state === "ok" && templates && templates.length > 0 && (
        <div className="flex flex-col gap-7">
          {startError && (
            <p role="alert" className="text-center text-sm text-nao">
              {startError}
            </p>
          )}
          {!caps?.run && (
            <p className="text-center text-sm text-ink-mute">
              Você pode ver as atividades, mas não tem permissão para executá-las.
            </p>
          )}
          {ACTIVITY_CATEGORIES.map((cat) => {
            const group = templates.filter((t) => t.category === cat);
            if (group.length === 0) return null;
            return (
              <section key={cat} aria-label={ACTIVITY_CATEGORY_LABELS[cat]}>
                <h2 className="mb-3 text-center text-sm font-semibold uppercase tracking-widest text-ink-soft">
                  {ACTIVITY_CATEGORY_LABELS[cat]}
                </h2>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {group.map((t) => (
                    <div key={t.id} className="relative">
                      <button
                        type="button"
                        disabled={!caps?.run || starting != null}
                        onClick={() => void start(t)}
                        className="flex w-full flex-col items-center gap-1.5 rounded-3xl border border-line/70 bg-card/70 px-5 py-7 shadow-soft backdrop-blur-md transition-transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60 disabled:hover:scale-100"
                      >
                        <span className="text-xl font-medium tracking-tight">
                          {starting === t.id ? "Iniciando…" : t.title}
                        </span>
                        {t.description && (
                          <span className="text-sm text-ink-soft">{t.description}</span>
                        )}
                        <span className="text-xs text-ink-mute">
                          {t.items.length} {t.items.length === 1 ? "item" : "itens"}
                        </span>
                      </button>
                      {/* Edição contextual: abre Gerenciar já NESTA atividade. */}
                      {caps?.edit && (
                        <ContextualEdit
                          target={{ entityType: "activity", activityId: t.id }}
                          source="/atividades"
                          label={t.title}
                          className="absolute -right-2 -top-2"
                        />
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex flex-1 flex-col">
      <OverlayVeil />
      <main className="relative flex w-full flex-1 flex-col justify-center px-4 pb-6 pl-14 sm:px-6 sm:pl-20 xl:pl-6">
        <div className="fade-rise pointer-events-auto mx-auto flex w-full max-w-4xl flex-col gap-6 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
