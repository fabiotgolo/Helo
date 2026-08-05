"use client";

// ——— Contexto da conversa (Fase 4.8) ———
//
// Uma etapa discreta ANTES da conversa: com quem, para quê, onde e sobre o quê.
// Tudo opcional, inclusive a etapa inteira.
//
// Duas regras dão forma a estas telas:
//
//   1. "Começar sem contexto" aparece no ALTO e no fim do formulário. Uma
//      conversa urgente não pode ficar atrás de um formulário — quem precisa
//      falar agora nunca deve ter que rolar a tela para escapar dele.
//   2. Nada aqui é fala do paciente. O texto é anotação do cuidador sobre a
//      circunstância, e a tela diz isso com todas as letras — para que ninguém,
//      lendo o histórico depois, confunda a intenção anotada com algo que o
//      paciente declarou.
//
// Editar durante a sessão não reescreve: cria uma versão nova e preserva a
// anterior. A tela avisa antes de gravar.

import { useEffect, useState } from "react";
import { ModalShell } from "@/components/modal-shell";
import { RascunhoLocalAviso } from "@/components/realtime-questions/offline-chip";
import {
  EMPTY_INTERLOCUTOR,
  PersonPicker,
  type InterlocutorValue,
} from "@/components/realtime-questions/person-picker";
import {
  Control,
  EditButton,
  Primary,
} from "@/components/realtime-questions/ui";
import {
  contextSummary,
  ENVIRONMENT_SHORTCUTS,
  INTENTION_SHORTCUTS,
  MAX_CONTEXT_FIELD_LEN,
  MAX_CONTEXT_NOTES_LEN,
  type SessionContextVersion,
} from "@/lib/session-context-types";
import type { OfflineBridge } from "@/lib/offline/use-offline-session";

/**
 * Chaves dos rascunhos DESTAS telas (Fase 4.9.3).
 *
 * São duas, e não uma, porque as duas telas partem de valores diferentes: a
 * inicial nasce vazia, a de edição nasce preenchida com a versão vigente.
 * Compartilhar a chave faria um texto abandonado numa reaparecer na outra
 * como se fosse o que valia — e contexto trocado é o tipo de erro que só se
 * descobre lendo o histórico depois.
 *
 * Quem as APAGA depois de gravar é `session.tsx`, no caminho de sucesso de
 * `salvarContexto` — mesma regra da pergunta e da interpretação: o rascunho só
 * sai quando o registro entrou.
 */
export const RASCUNHO_CONTEXTO = "contexto";
export const RASCUNHO_CONTEXTO_EDICAO = "contexto-edicao";

/** Há algo digitado? É o que decide se a marca de rascunho local aparece. */
function temConteudo(draft: ContextDraft): boolean {
  return Boolean(
    draft.interlocutor.personId ||
      draft.interlocutor.name.trim() ||
      draft.interlocutor.relation.trim() ||
      draft.intention.trim() ||
      draft.environment.trim() ||
      draft.initialTopic.trim() ||
      draft.notes.trim()
  );
}

export interface ContextDraft {
  interlocutor: InterlocutorValue;
  intention: string;
  environment: string;
  initialTopic: string;
  notes: string;
}

export const EMPTY_CONTEXT_DRAFT: ContextDraft = {
  interlocutor: EMPTY_INTERLOCUTOR,
  intention: "",
  environment: "",
  initialTopic: "",
  notes: "",
};

export function draftFromContext(context: SessionContextVersion): ContextDraft {
  return {
    interlocutor: {
      personId: context.interlocutorPersonId,
      name: context.interlocutorName ?? "",
      relation: context.interlocutorRelation ?? "",
    },
    intention: context.intention ?? "",
    environment: context.environment ?? "",
    initialTopic: context.initialTopic ?? "",
    notes: context.notes ?? "",
  };
}

/** Chips de sugestão: poupam digitação e nunca limitam o conteúdo (§3, §4). */
function Atalhos({
  legenda,
  opcoes,
  valor,
  onEscolher,
  disabled,
}: {
  legenda: string;
  opcoes: readonly string[];
  valor: string;
  onEscolher: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={legenda}>
      {opcoes.map((o) => {
        const ativo = valor.trim() === o;
        return (
          <button
            key={o}
            type="button"
            onClick={() => onEscolher(ativo ? "" : o)}
            disabled={disabled}
            aria-pressed={ativo}
            className={`min-h-11 rounded-full border px-4 py-2 text-sm transition-colors disabled:opacity-40 ${
              ativo
                ? "border-accent bg-accent/10 font-medium text-ink"
                : "border-line text-ink-soft hover:border-ink-mute"
            }`}
          >
            {ativo && <span aria-hidden="true">✓ </span>}
            {o}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Os campos avisam O QUE MUDOU, não o rascunho inteiro.
 *
 * A versão anterior mandava `{ ...draft, campo: valor }`, com `draft` fechado
 * na renderização. Funcionava até uma atualização de estado vinda de fora
 * (agora existem várias, assíncronas, do armazenamento local) cair entre o
 * evento e a gravação: o rascunho "novo" era montado sobre uma cópia velha, e
 * o campo digitado ANTES voltava ao valor anterior. Some um campo, sem erro e
 * sem aviso — e num formulário de contexto clínico isso é dado perdido.
 *
 * Mandando só o pedaço, quem aplica é o dono do estado, com atualização
 * funcional. Não há closure velha para atropelar nada.
 */
function CamposDoContexto({
  patientId,
  draft,
  onChange,
  busy,
}: {
  patientId: number;
  draft: ContextDraft;
  onChange: (patch: Partial<ContextDraft>) => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-col gap-5">
      <PersonPicker
        patientId={patientId}
        value={draft.interlocutor}
        onChange={(interlocutor) => onChange({ interlocutor })}
        disabled={busy}
      />

      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Intenção da conversa</span>
          <input
            type="text"
            value={draft.intention}
            maxLength={MAX_CONTEXT_FIELD_LEN}
            disabled={busy}
            onChange={(e) => onChange({ intention: e.target.value })}
            className="min-h-11 rounded-xl border border-line bg-bg px-3 text-ink"
          />
        </label>
        <Atalhos
          legenda="Sugestões de intenção"
          opcoes={INTENTION_SHORTCUTS}
          valor={draft.intention}
          onEscolher={(intention) => onChange({ intention })}
          disabled={busy}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Ambiente</span>
          <input
            type="text"
            value={draft.environment}
            maxLength={MAX_CONTEXT_FIELD_LEN}
            disabled={busy}
            onChange={(e) => onChange({ environment: e.target.value })}
            className="min-h-11 rounded-xl border border-line bg-bg px-3 text-ink"
          />
        </label>
        <Atalhos
          legenda="Sugestões de ambiente"
          opcoes={ENVIRONMENT_SHORTCUTS}
          valor={draft.environment}
          onEscolher={(environment) => onChange({ environment })}
          disabled={busy}
        />
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink">Assunto inicial</span>
        <input
          type="text"
          value={draft.initialTopic}
          maxLength={MAX_CONTEXT_FIELD_LEN}
          disabled={busy}
          onChange={(e) => onChange({ initialTopic: e.target.value })}
          className="min-h-11 rounded-xl border border-line bg-bg px-3 text-ink"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink">Observação complementar</span>
        <textarea
          value={draft.notes}
          maxLength={MAX_CONTEXT_NOTES_LEN}
          rows={3}
          disabled={busy}
          onChange={(e) => onChange({ notes: e.target.value })}
          className="rounded-xl border border-line bg-bg px-3 py-2 text-ink"
        />
      </label>
    </div>
  );
}

/** Etapa anterior à conversa. Pular é uma saída de primeira classe. */
export function SessionContextScreen({
  patientId,
  busy,
  onSave,
  onSkip,
  offline,
}: {
  patientId: number;
  busy: boolean;
  onSave: (draft: ContextDraft) => void;
  onSkip: () => void;
  /** Guarda o que foi digitado e ainda não gravado (Fase 4.9.3). */
  offline?: OfflineBridge;
}) {
  // Mesmo desenho do nível em construção (option-conversation/flow.tsx): quem
  // manda enquanto o cuidador digita é o estado local; o que está guardado é
  // só o valor de PARTIDA, lido sem estado e sem re-renderizar por isso.
  const [digitado, setDigitado] = useState<ContextDraft | null>(null);

  const guardado = offline?.rascunhosProntos
    ? (offline.lerRascunho(RASCUNHO_CONTEXTO) as ContextDraft | undefined)
    : undefined;

  const draft = digitado ?? guardado ?? EMPTY_CONTEXT_DRAFT;

  // A atualização é FUNCIONAL de propósito. Montar o próximo a partir do
  // `draft` desta renderização já custou um campo perdido uma vez: dois
  // eventos antes do próximo render partiam da mesma cópia velha, e o segundo
  // desfazia o primeiro.
  const aplicar = (patch: Partial<ContextDraft>) =>
    setDigitado((atual) => ({
      ...(atual ?? guardado ?? EMPTY_CONTEXT_DRAFT),
      ...patch,
    }));

  // A gravação mora num efeito, e não dentro do atualizador de estado: um
  // atualizador precisa ser puro, e o React pode executá-lo duas vezes.
  useEffect(() => {
    if (digitado) offline?.definirRascunho(RASCUNHO_CONTEXTO, digitado);
  }, [digitado, offline]);

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl font-medium text-ink">
          Contexto da conversa (opcional)
        </h2>
        <p className="text-sm text-ink-soft">
          Anotação do cuidador sobre a circunstância. Não é fala do paciente e
          nunca é apresentada a ele.
        </p>
      </header>

      {/* A saída rápida vem ANTES do formulário: quem precisa falar agora não
          deve ter que atravessar campo nenhum. */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-card/60 px-4 py-3">
        <Control onClick={onSkip} disabled={busy}>
          Começar sem contexto
        </Control>
        <span className="text-sm text-ink-soft">
          A conversa começa na hora; o contexto pode ser preenchido depois.
        </span>
      </div>

      <CamposDoContexto
        patientId={patientId}
        draft={draft}
        onChange={aplicar}
        busy={busy}
      />

      <RascunhoLocalAviso
        visivel={Boolean(offline?.disponivel) && temConteudo(draft)}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Primary onClick={() => onSave(draft)} disabled={busy}>
          Salvar e começar
        </Primary>
        <Control onClick={onSkip} disabled={busy}>
          Começar sem contexto
        </Control>
      </div>
    </section>
  );
}

/** Resumo de uma linha durante a sessão — só nas telas do cuidador. */
export function SessionContextBar({
  context,
  busy,
  onEdit,
  onView,
}: {
  context: SessionContextVersion;
  busy: boolean;
  onEdit: () => void;
  onView: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-card/40 px-4 py-2">
      <span className="text-xs font-semibold uppercase tracking-widest text-ink-soft">
        Contexto
      </span>
      <button
        type="button"
        onClick={onView}
        disabled={busy}
        className="min-h-9 flex-1 truncate text-left text-sm text-ink underline-offset-4 hover:underline disabled:opacity-40"
      >
        {contextSummary(context)}
      </button>
      {context.version > 1 && (
        <span className="text-xs text-ink-soft">versão {context.version}</span>
      )}
      <EditButton label="o contexto da conversa" onClick={onEdit} disabled={busy} />
    </div>
  );
}

/** Edição durante a sessão — sempre cria versão nova, e a tela avisa. */
export function SessionContextDialog({
  patientId,
  context,
  busy,
  onSave,
  onClose,
  offline,
}: {
  patientId: number;
  context: SessionContextVersion;
  busy: boolean;
  onSave: (draft: ContextDraft) => void;
  onClose: () => void;
  /** Guarda o que foi digitado e ainda não gravado (Fase 4.9.3). */
  offline?: OfflineBridge;
}) {
  const [digitado, setDigitado] = useState<ContextDraft | null>(null);

  // Aqui o ponto de partida NÃO é vazio: é a versão que vale agora. Um
  // rascunho guardado só entra na frente dela se existir.
  const base = context.skipped ? EMPTY_CONTEXT_DRAFT : draftFromContext(context);
  const guardado = offline?.rascunhosProntos
    ? (offline.lerRascunho(RASCUNHO_CONTEXTO_EDICAO) as ContextDraft | undefined)
    : undefined;

  const draft = digitado ?? guardado ?? base;

  const aplicar = (patch: Partial<ContextDraft>) =>
    setDigitado((atual) => ({ ...(atual ?? guardado ?? base), ...patch }));

  useEffect(() => {
    if (digitado) offline?.definirRascunho(RASCUNHO_CONTEXTO_EDICAO, digitado);
  }, [digitado, offline]);

  /**
   * Fechar é cancelamento EXPLÍCITO, e o rascunho sai do aparelho.
   *
   * Vale para "Cancelar" e para o descarte do modal (ESC, clique fora), porque
   * `ModalShell` os trata pelo mesmo caminho. Preferimos assim a guardar um
   * texto que o cuidador acha que descartou: a versão vigente continua
   * intacta, e é ela que a tela mostra ao reabrir.
   */
  const fechar = () => {
    setDigitado(null);
    offline?.descartarRascunho(RASCUNHO_CONTEXTO_EDICAO);
    onClose();
  };

  return (
    <ModalShell
      onClose={fechar}
      label="Editar o contexto da conversa"
      disableDismiss={busy}
    >
      <div className="flex flex-col gap-5">
        <h2 className="text-xl font-medium text-ink">
          Editar o contexto da conversa
        </h2>
        <p className="text-sm text-ink-soft">
          A versão atual é preservada: esta edição cria a versão{" "}
          {context.version + 1}, e o histórico continua mostrando o que valia
          antes.
        </p>
        <CamposDoContexto
          patientId={patientId}
          draft={draft}
          onChange={aplicar}
          busy={busy}
        />
        <RascunhoLocalAviso
          visivel={Boolean(offline?.disponivel) && digitado != null}
        />
        <div className="flex flex-wrap gap-3">
          <Primary onClick={() => onSave(draft)} disabled={busy}>
            Salvar nova versão
          </Primary>
          <Control onClick={fechar} disabled={busy}>
            Cancelar
          </Control>
        </div>
      </div>
    </ModalShell>
  );
}

/** Versões em leitura — o que valia em cada momento da conversa. */
export function ContextVersionsList({
  versions,
  onClose,
}: {
  versions: SessionContextVersion[];
  onClose: () => void;
}) {
  return (
    <ModalShell onClose={onClose} label="Contexto da conversa">
      <h2 className="text-xl font-medium text-ink">Contexto da conversa</h2>
      <ol className="mt-4 flex flex-col gap-3">
        {versions.map((v) => (
          <li
            key={v.id}
            className="flex flex-col gap-1 rounded-2xl border border-line bg-bg/40 px-4 py-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-ink">
                Versão {v.version}
              </span>
              {v.status === "ACTIVE" ? (
                <span className="text-xs text-ink-soft">vigente</span>
              ) : (
                <span className="text-xs text-ink-soft">substituída</span>
              )}
            </div>
            <p className="text-sm text-ink">{contextSummary(v)}</p>
            {v.notes && <p className="text-sm text-ink-soft">{v.notes}</p>}
          </li>
        ))}
      </ol>
      {/* Saída visível: o modo é operado no tablet à beira do leito, onde não
          existe Esc. Consultar o contexto no meio de um caminho só é seguro
          se voltar for tão óbvio quanto abrir. */}
      <div className="mt-5 flex">
        <Control onClick={onClose}>Fechar</Control>
      </div>
    </ModalShell>
  );
}
