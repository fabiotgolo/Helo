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
import { ActivityItemView, mediaSrc } from "@/components/activity-player";
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_CATEGORY_HINTS,
  ACTIVITY_CATEGORY_LABELS,
  MEDIA_ALLOWED_TYPES,
  MEDIA_MAX_BYTES,
  youtubeEmbedUrl,
  type ActivityCaps,
  type ActivityCategory,
  type ActivityItem,
  type ActivityMedia,
  type ActivityTemplate,
  type PatientMediaMeta,
} from "@/lib/activity-types";

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
        items: t.items.map((i) => ({ ...i, media: [...i.media], options: [...i.options] })),
      }
    : { id: null, title: "", description: "", category: "entretenimento", items: [blankItem()] };
}

export default function GerenciarAtividadesPage() {
  const { patient, patientId } = usePatient();
  const [templates, setTemplates] = useState<ActivityTemplate[] | null>(null);
  const [caps, setCaps] = useState<ActivityCaps | null>(null);
  const [state, setState] = useState<"ok" | "carregando" | "negado" | "erro">("carregando");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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
      setNotice(`"${d.template.title}" salva (versão ${d.template.version}).`);
      await load();
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [draft, patientId, saving, load]);

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
    <div className="flex min-h-dvh flex-col">
      <TopBar
        right={
          <>
            <PillLink href="/atividades">← Atividades</PillLink>
            <PillLink href="/dashboard">Dashboard</PillLink>
          </>
        }
      />
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6">
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
              className="mt-3 rounded-full bg-ink px-6 py-2.5 font-medium text-white"
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
                className="w-fit rounded-full bg-ink px-6 py-3 font-medium text-white hover:bg-black"
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
                          onClick={() => {
                            if (
                              window.confirm(
                                `Excluir "${t.title}"? O histórico de sessões já realizadas é preservado.`
                              )
                            ) {
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
            onSave={() => void save()}
            onCancel={() => {
              setDraft(null);
              setPreview(false);
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
  onSave,
  onCancel,
}: {
  draft: Draft;
  setDraft: (d: Draft | null) => void;
  patientId: number;
  preview: boolean;
  setPreview: (v: boolean) => void;
  saving: boolean;
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
                    ? "border-ink bg-ink text-white"
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
          className="rounded-full bg-ink px-8 py-3 font-medium text-white hover:bg-black disabled:opacity-50"
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
  onChange,
  onMove,
  onRemove,
}: {
  item: ActivityItem;
  index: number;
  total: number;
  patientId: number;
  onChange: (p: Partial<ActivityItem>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const isQuestion = item.question.trim().length > 0;

  const setOption = (i: number, label: string) => {
    const options = [...item.options];
    while (options.length <= i) {
      options.push({ id: newId(`${item.id}o`), label: "" });
    }
    options[i] = { ...options[i], label };
    onChange({ options });
  };

  return (
    <div className="flex flex-col gap-4 rounded-3xl border border-line bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold uppercase tracking-widest text-ink-soft">
          Item {index + 1}
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
            onChange({
              question,
              // pergunta liga os gestos por padrão; item de conteúdo desliga
              gesturesEnabled: question.trim().length > 0,
            });
          }}
          placeholder='ex.: "Qual é o nome dele?"'
          className="w-full rounded-2xl border border-line bg-white px-4 py-2.5"
        />
      </Field>

      {isQuestion && (
        <div className="flex flex-col gap-3 rounded-2xl bg-cream p-4">
          <p className="text-sm font-medium text-ink-soft">
            Opções de resposta (a resposta observada — diferente dos gestos 👍✋✊,
            que ficam sempre visíveis)
          </p>
          {[0, 1, 2].map((i) => {
            const opt = item.options[i];
            return (
              <div key={i} className="flex items-center gap-3">
                <input
                  value={opt?.label ?? ""}
                  onChange={(e) => setOption(i, e.target.value)}
                  placeholder={`Opção ${i + 1}`}
                  className="min-w-0 flex-1 rounded-2xl border border-line bg-white px-4 py-2.5"
                />
                <label className="flex shrink-0 items-center gap-1.5 text-sm text-ink-soft">
                  <input
                    type="radio"
                    name={`correta-${item.id}`}
                    checked={Boolean(opt && item.correctOptionId === opt.id)}
                    disabled={!opt?.label.trim()}
                    onChange={() => opt && onChange({ correctOptionId: opt.id })}
                  />
                  correta
                </label>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => onChange({ correctOptionId: null })}
            disabled={!item.correctOptionId}
            className="w-fit rounded-full border border-line bg-white px-3 py-1 text-xs font-medium disabled:opacity-40"
          >
            Sem resposta correta (sem certo/errado)
          </button>
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
