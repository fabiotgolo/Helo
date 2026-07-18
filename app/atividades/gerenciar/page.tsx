"use client";

// ——— Gerenciar Atividades: o MODO DE EDIÇÃO das sessões personalizadas ———
// Página separada do modo de uso (/atividades) por regra do produto: nada
// aqui roda sessão, e nada lá edita conteúdo — sem edição acidental durante
// uma sessão em andamento.
//
// Opera sobre o PACIENTE ATIVO (mesmo contrato de Ajustes). A autorização
// real é do servidor: esta tela só decide o que exibir a partir das
// capacidades (caps) devolvidas pela API.

import { useCallback, useEffect, useRef, useState } from "react";
import { TopBar, PillLink } from "@/components/ui";
import { usePatient } from "@/lib/patient";
import { redirectToLogin } from "@/lib/use-auth";
import { readSearchParams, safeReturnTo } from "@/lib/edit-link";
import { ActivityItemView, mediaSrc } from "@/components/activity-player";
import { useHeloDialog } from "@/components/helo-dialog";
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_CATEGORY_HINTS,
  ACTIVITY_CATEGORY_LABELS,
  MEDIA_ALLOWED_TYPES,
  MEDIA_MAX_BYTES,
  suggestOptionResponses,
  youtubeEmbedUrl,
  type ActivityCaps,
  type ActivityCategory,
  type ActivityItem,
  type ActivityMedia,
  type ActivityOption,
  type ActivityTemplate,
  type PatientMediaMeta,
} from "@/lib/activity-types";
import type { Gesture } from "@/lib/types";

// Ordem canônica das respostas faladas no editor — SIM, TALVEZ, NÃO.
const RESPONSE_GESTURES: { g: Gesture; label: string }[] = [
  { g: "sim", label: "SIM" },
  { g: "talvez", label: "TALVEZ" },
  { g: "nao", label: "NÃO" },
];
const MAX_OPTIONS_UI = 6;

let seq = 0;
function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;
}

function blankItem(): ActivityItem {
  return {
    id: newId("i"),
    order: 0,
    title: "",
    text: "",
    media: [],
    question: "",
    options: [],
    correctOptionId: null,
    gesturesEnabled: false,
  };
}

type Draft = {
  id: string | null;
  title: string;
  description: string;
  category: ActivityCategory;
  items: ActivityItem[];
};

function draftFrom(t: ActivityTemplate | null): Draft {
  return t
    ? {
        id: t.id,
        title: t.title,
        description: t.description,
        category: t.category,
        items: t.items.map((i) => ({
          ...i,
          media: [...i.media],
          options: i.options.map((o) => ({
            ...o,
            responses: o.responses ? { ...o.responses } : undefined,
          })),
        })),
      }
    : { id: null, title: "", description: "", category: "entretenimento", items: [blankItem()] };
}

export default function GerenciarAtividadesPage() {
  const { patient, patientId } = usePatient();
  const dialog = useHeloDialog();
  const [templates, setTemplates] = useState<ActivityTemplate[] | null>(null);
  const [caps, setCaps] = useState<ActivityCaps | null>(null);
  const [state, setState] = useState<"ok" | "carregando" | "negado" | "erro">("carregando");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // ——— Edição contextual (deep link) ———
  // ?activityId=…&itemId=…&returnTo=… abre a atividade exata com o editor já
  // posicionado no item, e devolve o usuário à tela de origem ao salvar ou
  // cancelar. A URL identifica o item de forma estável: reload reabre o
  // mesmo contexto. A autorização continua sendo do servidor (caps/rotas).
  const [editCtx, setEditCtx] = useState<{
    activityId: string | null;
    itemId: string | null;
    returnTo: string | null;
  } | null>(null);
  // Lido num efeito (não no initializer): na navegação client-side a URL só
  // é confiável depois da montagem da rota.
  useEffect(() => {
    const q = readSearchParams();
    setEditCtx({
      activityId: q.get("activityId"),
      itemId: q.get("itemId"),
      returnTo: safeReturnTo(q.get("returnTo")),
    });
  }, []);
  const returnTo = editCtx?.returnTo ?? null;
  const [focusItemId, setFocusItemId] = useState<string | null>(null);
  // Abre o draft pedido pelo deep link assim que a lista chega — uma vez.
  useEffect(() => {
    const ctx = editCtx;
    if (!ctx?.activityId || state !== "ok" || !templates || draft) return;
    const wanted = ctx.activityId;
    setEditCtx({ ...ctx, activityId: null });
    const t = templates.find((x) => x.id === wanted);
    if (!t) {
      setErrorMsg("Atividade não encontrada — pode ter sido excluída.");
      return;
    }
    if (!caps?.edit) {
      setErrorMsg("Sem permissão para editar esta atividade.");
      return;
    }
    setDraft(draftFrom(t));
    setFocusItemId(ctx.itemId);
  }, [editCtx, state, templates, caps, draft]);

  const load = useCallback(async () => {
    if (patientId == null) return;
    try {
      const r = await fetch(`/api/activities?patientId=${patientId}&all=1`);
      if (r.status === 401) {
        redirectToLogin();
        return;
      }
      if (r.status === 403) {
        setState("negado");
        return;
      }
      if (!r.ok) throw new Error();
      const d = (await r.json()) as { templates: ActivityTemplate[]; caps: ActivityCaps };
      setTemplates(d.templates);
      setCaps(d.caps);
      // Quem não cria nem edita não usa esta tela (só visualiza no modo de uso).
      setState(d.caps.create || d.caps.edit ? "ok" : "negado");
    } catch {
      setState("erro");
    }
  }, [patientId]);

  useEffect(() => {
    setState("carregando");
    setDraft(null);
    setTemplates(null);
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (!draft || patientId == null || saving) return;
    setSaving(true);
    setErrorMsg(null);
    try {
      const payload = {
        title: draft.title,
        description: draft.description,
        category: draft.category,
        items: draft.items,
      };
      const r = await fetch("/api/activities", {
        method: draft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          draft.id
            ? { patientId, templateId: draft.id, template: payload }
            : { patientId, template: payload }
        ),
      });
      const d = (await r.json().catch(() => null)) as
        | { template?: ActivityTemplate; error?: string }
        | null;
      if (!r.ok || !d?.template) throw new Error(d?.error ?? "falha ao salvar");
      setDraft(null);
      setPreview(false);
      setFocusItemId(null);
      // Veio por edição contextual: salvar devolve direto à tela de origem
      // (returnTo é sempre um caminho interno, validado por safeReturnTo).
      if (returnTo) {
        window.location.assign(returnTo);
        return;
      }
      setNotice(`"${d.template.title}" salva (versão ${d.template.version}).`);
      await load();
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [draft, patientId, saving, load, returnTo]);

  const act = useCallback(
    async (
      method: "POST" | "PATCH" | "DELETE",
      body: Record<string, unknown>,
      okMsg: string
    ) => {
      setErrorMsg(null);
      try {
        const r = await fetch("/api/activities", {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patientId, ...body }),
        });
        if (!r.ok) {
          const d = (await r.json().catch(() => null)) as { error?: string } | null;
          throw new Error(d?.error ?? "operação falhou");
        }
        setNotice(okMsg);
        await load();
      } catch (e) {
        setErrorMsg((e as Error).message);
      }
    },
    [patientId, load]
  );

  return (
    <div className="flex min-h-dvh flex-col pb-24 sm:pb-0">
      <TopBar
        right={
          <>
            {returnTo && returnTo !== "/atividades" && (
              <PillLink href={returnTo}>← Voltar</PillLink>
            )}
            <PillLink href="/atividades">← Atividades</PillLink>
            <PillLink href="/dashboard">Dashboard</PillLink>
          </>
        }
      />
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-6 pl-14 sm:px-6 sm:pl-20 xl:pl-6">
        <div>
          <h1 className="text-3xl font-medium tracking-tight">Gerenciar Atividades</h1>
          <p className="text-ink-soft">
            Sessões personalizadas de{" "}
            <strong className="font-medium">{patient?.name ?? "…"}</strong> — modo
            de edição, separado do modo de uso.
          </p>
        </div>

        {notice && (
          <p role="status" className="rounded-2xl bg-sim-soft px-4 py-2.5 text-sm text-sim">
            {notice}
          </p>
        )}
        {errorMsg && (
          <p role="alert" className="rounded-2xl bg-nao-soft px-4 py-2.5 text-sm text-nao">
            {errorMsg}
          </p>
        )}

        {state === "carregando" && <p className="text-ink-mute">Carregando…</p>}

        {state === "negado" && (
          <div role="alert" className="rounded-3xl border border-line bg-card p-8 text-center">
            <p className="text-lg">Sem permissão para gerenciar as Atividades deste paciente.</p>
            <p className="mt-2 text-sm text-ink-soft">
              Peça ao administrador as permissões “Criar Atividades” ou “Editar
              Atividades” no seu vínculo.
            </p>
          </div>
        )}

        {state === "erro" && (
          <div role="alert" className="rounded-3xl border border-line bg-card p-8 text-center">
            <p>Não foi possível carregar. </p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 rounded-full bg-accent px-6 py-2.5 font-medium text-on-accent"
            >
              Tentar de novo
            </button>
          </div>
        )}

        {state === "ok" && !draft && templates && (
          <>
            {caps?.create && (
              <button
                type="button"
                onClick={() => setDraft(draftFrom(null))}
                className="w-fit rounded-full bg-accent px-6 py-3 font-medium text-on-accent hover:bg-accent-strong"
              >
                + Nova atividade
              </button>
            )}
            {templates.length === 0 ? (
              <p className="rounded-3xl border border-line bg-card p-8 text-center text-ink-soft">
                Nenhuma sessão personalizada criada ainda.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {templates.map((t) => (
                  <li
                    key={t.id}
                    className="flex flex-col gap-3 rounded-3xl border border-line bg-card p-5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-lg font-medium tracking-tight">{t.title}</span>
                      <span className="rounded-full bg-cream px-2.5 py-0.5 text-xs text-ink-soft">
                        {ACTIVITY_CATEGORY_LABELS[t.category]}
                      </span>
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          t.status === "ativa"
                            ? "bg-sim-soft text-sim"
                            : "bg-cream text-ink-mute"
                        }`}
                      >
                        {t.status}
                      </span>
                      <span className="text-xs text-ink-mute">
                        v{t.version} · {t.items.length}{" "}
                        {t.items.length === 1 ? "item" : "itens"}
                      </span>
                    </div>
                    <p className="text-xs text-ink-mute">
                      Criada por {t.createdByName ?? "—"} · última alteração de{" "}
                      {t.updatedByName ?? "—"}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {caps?.edit && (
                        <SmallBtn onClick={() => setDraft(draftFrom(t))}>Editar</SmallBtn>
                      )}
                      {caps?.create && (
                        <SmallBtn
                          onClick={() =>
                            void act(
                              "POST",
                              { action: "duplicate", templateId: t.id },
                              `"${t.title}" duplicada.`
                            )
                          }
                        >
                          Duplicar
                        </SmallBtn>
                      )}
                      {caps?.edit && (
                        <SmallBtn
                          onClick={() =>
                            void act(
                              "PATCH",
                              {
                                templateId: t.id,
                                template: {
                                  status: t.status === "ativa" ? "inativa" : "ativa",
                                },
                              },
                              t.status === "ativa"
                                ? `"${t.title}" desativada.`
                                : `"${t.title}" ativada.`
                            )
                          }
                        >
                          {t.status === "ativa" ? "Desativar" : "Ativar"}
                        </SmallBtn>
                      )}
                      {caps?.delete && (
                        <SmallBtn
                          danger
                          onClick={async () => {
                            const ok = await dialog.confirm({
                              title: "Excluir atividade?",
                              message: `Excluir "${t.title}"? O histórico de sessões já realizadas é preservado.`,
                              confirmLabel: "Excluir",
                              cancelLabel: "Cancelar",
                              tone: "danger",
                            });
                            if (ok) {
                              void act(
                                "DELETE",
                                { templateId: t.id },
                                `"${t.title}" excluída.`
                              );
                            }
                          }}
                        >
                          Excluir
                        </SmallBtn>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-ink-mute">
              As atividades pertencem ao paciente e aparecem para todos os
              usuários vinculados com permissão — nunca a outros pacientes.
            </p>
          </>
        )}

        {state === "ok" && draft && patientId != null && (
          <TemplateEditor
            draft={draft}
            setDraft={setDraft}
            patientId={patientId}
            preview={preview}
            setPreview={setPreview}
            saving={saving}
            focusItemId={focusItemId}
            onSave={() => void save()}
            onCancel={() => {
              setDraft(null);
              setPreview(false);
              setFocusItemId(null);
              // Cancelar também devolve à origem da edição contextual.
              if (returnTo) window.location.assign(returnTo);
            }}
          />
        )}
      </main>
    </div>
  );
}

function SmallBtn({
  children,
  onClick,
  danger = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
        danger
          ? "border-nao/40 bg-nao-soft text-nao hover:border-nao"
          : "border-line bg-card hover:border-ink-mute"
      }`}
    >
      {children}
    </button>
  );
}

// ——— Editor de template ———

function TemplateEditor({
  draft,
  setDraft,
  patientId,
  preview,
  setPreview,
  saving,
  focusItemId = null,
  onSave,
  onCancel,
}: {
  draft: Draft;
  setDraft: (d: Draft | null) => void;
  patientId: number;
  preview: boolean;
  setPreview: (v: boolean) => void;
  saving: boolean;
  /** Deep link de edição contextual: rola até este item e o destaca. */
  focusItemId?: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  const patch = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
  const patchItem = (idx: number, p: Partial<ActivityItem>) => {
    const items = draft.items.map((it, i) => (i === idx ? { ...it, ...p } : it));
    patch({ items });
  };
  const move = (idx: number, dir: -1 | 1) => {
    const items = [...draft.items];
    const j = idx + dir;
    if (j < 0 || j >= items.length) return;
    [items[idx], items[j]] = [items[j], items[idx]];
    patch({ items });
  };

  if (preview) {
    return (
      <section aria-label="Pré-visualização" className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="rounded-full bg-cream px-4 py-1.5 text-sm text-ink-soft">
            Pré-visualização — nada é registrado aqui
          </p>
          <SmallBtn onClick={() => setPreview(false)}>← Voltar à edição</SmallBtn>
        </div>
        <div className="flex flex-col gap-10 rounded-3xl border border-line bg-card p-6 sm:p-10">
          <h2 className="text-center text-2xl font-medium tracking-tight">
            {draft.title || "(sem título)"}
          </h2>
          {draft.items.map((item, i) => (
            <div key={item.id} className="border-t border-line pt-8 first:border-t-0 first:pt-0">
              <p className="mb-4 text-center text-xs uppercase tracking-widest text-ink-mute">
                Item {i + 1}
              </p>
              <ActivityItemView item={item} patientId={patientId} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Editor de atividade" className="flex flex-col gap-5">
      <div className="flex flex-col gap-4 rounded-3xl border border-line bg-card p-5 sm:p-6">
        <Field label="Título">
          <input
            value={draft.title}
            onChange={(e) => patch({ title: e.target.value })}
            placeholder="ex.: Meu Livro, Reconhecimento dos Netos…"
            className="w-full rounded-2xl border border-line bg-white px-4 py-3"
          />
        </Field>
        <Field label="Descrição (opcional)">
          <input
            value={draft.description}
            onChange={(e) => patch({ description: e.target.value })}
            placeholder="breve contexto para quem for conduzir"
            className="w-full rounded-2xl border border-line bg-white px-4 py-3"
          />
        </Field>
        <Field label="Categoria">
          <div className="flex flex-wrap gap-2">
            {ACTIVITY_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => patch({ category: c })}
                aria-pressed={draft.category === c}
                title={ACTIVITY_CATEGORY_HINTS[c]}
                className={`rounded-full border px-4 py-2 text-sm font-medium ${
                  draft.category === c
                    ? "border-accent bg-accent text-on-accent"
                    : "border-line bg-card hover:border-ink-mute"
                }`}
              >
                {ACTIVITY_CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-ink-mute">
            {ACTIVITY_CATEGORY_HINTS[draft.category]}
          </p>
        </Field>
      </div>

      {draft.items.map((item, idx) => (
        <ItemEditor
          key={item.id}
          item={item}
          index={idx}
          total={draft.items.length}
          patientId={patientId}
          focused={item.id === focusItemId}
          onChange={(p) => patchItem(idx, p)}
          onMove={(dir) => move(idx, dir)}
          onRemove={() => patch({ items: draft.items.filter((_, i) => i !== idx) })}
        />
      ))}

      <button
        type="button"
        onClick={() => patch({ items: [...draft.items, blankItem()] })}
        className="w-fit rounded-full border border-line bg-card px-5 py-2.5 text-sm font-medium hover:border-ink-mute"
      >
        + Adicionar item
      </button>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
        <button
          type="button"
          onClick={onSave}
          disabled={saving || !draft.title.trim()}
          className="rounded-full bg-accent px-8 py-3 font-medium text-on-accent hover:bg-accent-strong disabled:opacity-50"
        >
          {saving ? "Salvando…" : draft.id ? "Salvar alterações" : "Criar atividade"}
        </button>
        <SmallBtn onClick={() => setPreview(true)}>Pré-visualizar</SmallBtn>
        <SmallBtn onClick={onCancel}>Cancelar</SmallBtn>
        {draft.id && (
          <p className="text-xs text-ink-mute">
            Alterar o conteúdo cria uma nova versão — sessões já realizadas
            preservam o que foi exibido na época.
          </p>
        )}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

// ——— Editor de um item ———

function ItemEditor({
  item,
  index,
  total,
  patientId,
  focused = false,
  onChange,
  onMove,
  onRemove,
}: {
  item: ActivityItem;
  index: number;
  total: number;
  patientId: number;
  /** Item pedido pelo deep link — rola até aqui e foca o primeiro campo. */
  focused?: boolean;
  onChange: (p: Partial<ActivityItem>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const isQuestion = item.question.trim().length > 0;
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focused || !rootRef.current) return;
    rootRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    rootRef.current
      .querySelector<HTMLInputElement>("input, textarea")
      ?.focus({ preventScroll: true });
    // roda uma vez, na montagem do editor com o item pedido
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateOption = (i: number, patch: Partial<ActivityOption>) => {
    onChange({
      options: item.options.map((o, j) => (j === i ? { ...o, ...patch } : o)),
    });
  };
  const addOption = () => {
    if (item.options.length >= MAX_OPTIONS_UI) return;
    onChange({
      options: [...item.options, { id: newId(`${item.id}o`), label: "" }],
    });
  };
  const removeOption = (i: number) => {
    const removed = item.options[i];
    const options = item.options.filter((_, j) => j !== i);
    const patch: Partial<ActivityItem> = { options };
    if (removed && item.correctOptionId === removed.id) patch.correctOptionId = null;
    onChange(patch);
  };
  const moveOption = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= item.options.length) return;
    const options = [...item.options];
    [options[i], options[j]] = [options[j], options[i]];
    onChange({ options });
  };
  const setResponse = (i: number, g: Gesture, text: string) => {
    const cur = item.options[i]?.responses ?? {};
    updateOption(i, { responses: { ...cur, [g]: text } });
  };
  const suggestResponses = (i: number) => {
    const label = item.options[i]?.label ?? "";
    updateOption(i, { responses: suggestOptionResponses(label) });
  };
  // Autofill discreto: ao sair do campo do rótulo, se ainda não há nenhuma
  // resposta falada, sugere as três (editáveis). Não sobrescreve o que já existe.
  const maybeSuggestOnBlur = (i: number) => {
    const o = item.options[i];
    if (!o || !o.label.trim()) return;
    const has = Object.values(o.responses ?? {}).some((v) => (v ?? "").trim());
    if (!has) suggestResponses(i);
  };

  return (
    <div
      ref={rootRef}
      className={`flex flex-col gap-4 rounded-3xl border bg-card p-5 sm:p-6 ${
        focused ? "border-accent ring-2 ring-ink/15" : "border-line"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold uppercase tracking-widest text-ink-soft">
          Item {index + 1}
          {focused && (
            <span className="ml-2 rounded-full bg-cream px-2 py-0.5 text-[10px] normal-case tracking-normal text-ink-soft">
              item que você estava vendo
            </span>
          )}
        </p>
        <div className="flex gap-1.5">
          <IconBtn label="Mover para cima" disabled={index === 0} onClick={() => onMove(-1)}>
            ↑
          </IconBtn>
          <IconBtn
            label="Mover para baixo"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </IconBtn>
          <IconBtn label="Remover item" disabled={total === 1} onClick={onRemove}>
            ✕
          </IconBtn>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Título do item (opcional)">
          <input
            value={item.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder="ex.: A capa do livro"
            className="w-full rounded-2xl border border-line bg-white px-4 py-2.5"
          />
        </Field>
        <Field label="Texto curto (opcional)">
          <input
            value={item.text}
            onChange={(e) => onChange({ text: e.target.value })}
            placeholder="pequeno texto contextual"
            className="w-full rounded-2xl border border-line bg-white px-4 py-2.5"
          />
        </Field>
      </div>

      <MediaEditor
        media={item.media}
        patientId={patientId}
        onChange={(media) => onChange({ media })}
      />

      <Field label="Pergunta (deixe vazio para item só de conteúdo)">
        <input
          value={item.question}
          onChange={(e) => {
            const question = e.target.value;
            const patch: Partial<ActivityItem> = {
              question,
              // pergunta liga os gestos por padrão; item de conteúdo desliga
              gesturesEnabled: question.trim().length > 0,
            };
            // Ao virar pergunta pela primeira vez, semeia 3 alternativas em
            // branco (padrão do brief). O usuário pode remover ou adicionar
            // (até 6). Alternativas vazias não são salvas.
            if (question.trim().length > 0 && item.options.length === 0) {
              patch.options = [0, 1, 2].map(() => ({
                id: newId(`${item.id}o`),
                label: "",
              }));
            }
            onChange(patch);
          }}
          placeholder='ex.: "Qual é o nome dele?"'
          className="w-full rounded-2xl border border-line bg-white px-4 py-2.5"
        />
      </Field>

      {isQuestion && (
        <div className="flex flex-col gap-4 rounded-2xl bg-cream p-4">
          <div>
            <p className="text-sm font-medium text-ink-soft">
              Alternativas de resposta
            </p>
            <p className="mt-0.5 text-xs text-ink-mute">
              Cada alternativa tem os três gestos 👍✋✊ na execução. Preencha as
              falas SIM/TALVEZ/NÃO para que a alternativa fale na voz do paciente
              ao ser escolhida — deixe em branco para apenas registrar o gesto.
            </p>
          </div>

          {item.options.map((opt, i) => (
            <div
              key={opt.id}
              className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-3"
            >
              <div className="flex items-center gap-2">
                <input
                  value={opt.label}
                  onChange={(e) => updateOption(i, { label: e.target.value })}
                  onBlur={() => maybeSuggestOnBlur(i)}
                  placeholder={`Alternativa ${i + 1}`}
                  className="min-w-0 flex-1 rounded-2xl border border-line bg-white px-4 py-2.5"
                />
                <label className="flex shrink-0 items-center gap-1.5 text-sm text-ink-soft">
                  <input
                    type="radio"
                    name={`correta-${item.id}`}
                    checked={item.correctOptionId === opt.id}
                    disabled={!opt.label.trim()}
                    onChange={() => onChange({ correctOptionId: opt.id })}
                  />
                  esperada
                </label>
                <IconBtn
                  label="Mover alternativa para cima"
                  disabled={i === 0}
                  onClick={() => moveOption(i, -1)}
                >
                  ↑
                </IconBtn>
                <IconBtn
                  label="Mover alternativa para baixo"
                  disabled={i === item.options.length - 1}
                  onClick={() => moveOption(i, 1)}
                >
                  ↓
                </IconBtn>
                <IconBtn
                  label="Remover alternativa"
                  disabled={item.options.length <= 1}
                  onClick={() => removeOption(i)}
                >
                  ✕
                </IconBtn>
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-ink-soft">
                    Falas do paciente (opcional)
                  </span>
                  <button
                    type="button"
                    onClick={() => suggestResponses(i)}
                    disabled={!opt.label.trim()}
                    className="rounded-full border border-line bg-cream px-3 py-1 text-xs font-medium hover:border-ink-mute disabled:opacity-40"
                  >
                    ✨ Sugerir respostas
                  </button>
                </div>
                {RESPONSE_GESTURES.map(({ g, label }) => (
                  <label key={g} className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-ink-mute">
                      {label}
                    </span>
                    <input
                      value={opt.responses?.[g] ?? ""}
                      onChange={(e) => setResponse(i, g, e.target.value)}
                      placeholder={`fala do paciente ao escolher ${label}`}
                      className="min-w-0 flex-1 rounded-xl border border-line bg-white px-3 py-2 text-sm"
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={addOption}
              disabled={item.options.length >= MAX_OPTIONS_UI}
              className="w-fit rounded-full border border-line bg-white px-4 py-1.5 text-sm font-medium hover:border-ink-mute disabled:opacity-40"
            >
              + Adicionar alternativa
            </button>
            <button
              type="button"
              onClick={() => onChange({ correctOptionId: null })}
              disabled={!item.correctOptionId}
              className="w-fit rounded-full border border-line bg-white px-3 py-1.5 text-xs font-medium disabled:opacity-40"
            >
              Sem resposta esperada (sem certo/errado)
            </button>
          </div>
          <p className="text-xs text-ink-mute">
            A “resposta esperada” é discreta: serve ao acompanhamento e ao
            Dashboard, nunca vira “errado” na tela para o paciente.
          </p>
        </div>
      )}
    </div>
  );
}

function IconBtn({
  children,
  label,
  onClick,
  disabled = false,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="h-9 w-9 rounded-full border border-line bg-card text-sm hover:border-ink-mute disabled:opacity-30"
    >
      {children}
    </button>
  );
}

// ——— Editor de mídia de um item ———

function MediaEditor({
  media,
  patientId,
  onChange,
}: {
  media: ActivityMedia[];
  patientId: number;
  onChange: (m: ActivityMedia[]) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkMode, setLinkMode] = useState<"youtube" | "imagem" | null>(null);
  const [linkValue, setLinkValue] = useState("");
  const [library, setLibrary] = useState<PatientMediaMeta[] | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);

  const upload = async (file: File) => {
    setError(null);
    if (!MEDIA_ALLOWED_TYPES.includes(file.type)) {
      setError("Formato inválido — use JPEG, PNG, WebP ou GIF.");
      return;
    }
    if (file.size > MEDIA_MAX_BYTES) {
      setError(
        `Imagem grande demais (${(file.size / 1_000_000).toFixed(1)} MB — máximo 2,5 MB).`
      );
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error("não foi possível ler o arquivo"));
        fr.readAsDataURL(file);
      });
      const r = await fetch("/api/media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId,
          name: file.name,
          contentType: file.type,
          dataBase64: dataUrl,
        }),
      });
      const d = (await r.json().catch(() => null)) as
        | { media?: PatientMediaMeta; error?: string }
        | null;
      if (!r.ok || !d?.media) throw new Error(d?.error ?? "falha no upload");
      onChange([
        ...media,
        { kind: "imagem", mediaId: d.media.id, url: null, caption: null },
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const addLink = () => {
    const url = linkValue.trim();
    if (!url) return;
    if (linkMode === "youtube" && !youtubeEmbedUrl(url)) {
      setError("Link do YouTube inválido — cole a URL completa do vídeo.");
      return;
    }
    setError(null);
    onChange([
      ...media,
      {
        kind: linkMode === "youtube" ? "youtube" : "imagem",
        mediaId: null,
        url,
        caption: null,
      },
    ]);
    setLinkMode(null);
    setLinkValue("");
  };

  const openLibrary = async () => {
    setShowLibrary(true);
    if (library) return;
    try {
      const r = await fetch(`/api/media?patientId=${patientId}`);
      if (!r.ok) throw new Error();
      setLibrary(((await r.json()) as { media: PatientMediaMeta[] }).media);
    } catch {
      setLibrary([]);
      setError("Não foi possível carregar a biblioteca.");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium text-ink-soft">Mídia (imagens e YouTube)</p>

      {media.length > 0 && (
        <ul className="flex flex-wrap gap-3">
          {media.map((m, i) => (
            <li
              key={i}
              className="flex items-center gap-2 rounded-2xl border border-line bg-white p-2"
            >
              {m.kind === "imagem" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={mediaSrc(m, patientId) ?? ""}
                  alt={m.caption ?? "miniatura"}
                  className="h-14 w-14 rounded-xl object-cover"
                />
              ) : (
                <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-cream text-xl">
                  ▶
                </span>
              )}
              <input
                value={m.caption ?? ""}
                onChange={(e) => {
                  const next = [...media];
                  next[i] = { ...m, caption: e.target.value || null };
                  onChange(next);
                }}
                placeholder="legenda (opcional)"
                className="w-36 rounded-xl border border-line px-2 py-1 text-sm"
              />
              <IconBtn label="Remover mídia" onClick={() => onChange(media.filter((_, j) => j !== i))}>
                ✕
              </IconBtn>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          ref={fileRef}
          type="file"
          accept={MEDIA_ALLOWED_TYPES.join(",")}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
        <SmallBtn onClick={() => fileRef.current?.click()}>
          {busy ? "Enviando…" : "📷 Enviar imagem"}
        </SmallBtn>
        <SmallBtn onClick={() => void openLibrary()}>🗂 Biblioteca</SmallBtn>
        <SmallBtn
          onClick={() => {
            setLinkMode(linkMode === "youtube" ? null : "youtube");
            setLinkValue("");
          }}
        >
          ▶ YouTube (link)
        </SmallBtn>
        <SmallBtn
          onClick={() => {
            setLinkMode(linkMode === "imagem" ? null : "imagem");
            setLinkValue("");
          }}
        >
          🌐 Imagem por URL
        </SmallBtn>
      </div>

      {linkMode && (
        <div className="flex gap-2">
          <input
            value={linkValue}
            onChange={(e) => setLinkValue(e.target.value)}
            placeholder={
              linkMode === "youtube"
                ? "https://www.youtube.com/watch?v=…"
                : "https://…/imagem.jpg"
            }
            className="min-w-0 flex-1 rounded-2xl border border-line bg-white px-4 py-2.5"
          />
          <SmallBtn onClick={addLink}>Adicionar</SmallBtn>
        </div>
      )}

      {showLibrary && (
        <div className="rounded-2xl border border-line bg-cream p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-ink-soft">
              Biblioteca do paciente — mídia já enviada
            </p>
            <SmallBtn onClick={() => setShowLibrary(false)}>Fechar</SmallBtn>
          </div>
          {!library ? (
            <p className="text-sm text-ink-mute">Carregando…</p>
          ) : library.length === 0 ? (
            <p className="text-sm text-ink-mute">Nenhuma mídia enviada ainda.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {library.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() =>
                      onChange([
                        ...media,
                        { kind: "imagem", mediaId: m.id, url: null, caption: null },
                      ])
                    }
                    title={m.name}
                    className="rounded-xl border border-line bg-white p-1 hover:border-ink-mute"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/media?patientId=${patientId}&id=${m.id}`}
                      alt={m.name}
                      className="h-16 w-16 rounded-lg object-cover"
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-nao">
          {error}
        </p>
      )}
    </div>
  );
}
