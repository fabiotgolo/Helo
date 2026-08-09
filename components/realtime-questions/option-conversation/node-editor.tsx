"use client";

// ——— Criação e revisão de um nível (§4, §6, §27) ———
// Título + até três opções, com indicação de opção terminal, frase associada e
// classificação sensível. Enquanto o nível está em rascunho, a edição acontece
// NESTE registro; depois de apresentado, o caminho é a versão corrigida (§28)
// e este editor não é mais oferecido.

import {
  Control,
  Primary,
} from "@/components/realtime-questions/ui";
import { DictationButton } from "@/components/voice/dictation-button";
import { useDictationField } from "@/lib/voice/use-dictation";
import {
  MAX_OPTIONS_PER_NODE,
  MAX_OPTION_LABEL_LEN,
  MAX_PROMPT_LEN,
  MAX_STATEMENT_LEN,
} from "@/lib/option-conversation-types";
import {
  SENSITIVE_CATEGORIES,
  SENSITIVE_CATEGORY_LABELS,
  type SensitiveCategory,
} from "@/lib/realtime-question-types";
import type { OptionDraft } from "@/lib/realtime-question-client";

export interface NodeDraft {
  promptText: string;
  options: OptionDraft[];
  isSensitive: boolean;
  sensitiveCategory: SensitiveCategory | null;
}

export function emptyDraft(): NodeDraft {
  return {
    promptText: "",
    options: [{ label: "" }],
    isSensitive: false,
    sensitiveCategory: null,
  };
}

export function draftFromNode(node: {
  promptText: string;
  options: {
    label: string;
    isTerminal: boolean;
    finalStatementDraft: string | null;
    isSensitive: boolean;
    sensitiveCategory: SensitiveCategory | null;
  }[];
  isSensitive: boolean;
  sensitiveCategory: SensitiveCategory | null;
}): NodeDraft {
  return {
    promptText: node.promptText,
    options: node.options.map((o) => ({
      label: o.label,
      isTerminal: o.isTerminal,
      finalStatementDraft: o.finalStatementDraft,
      isSensitive: o.isSensitive,
      sensitiveCategory: o.sensitiveCategory,
    })),
    isSensitive: node.isSensitive,
    sensitiveCategory: node.sensitiveCategory,
  };
}

/** O mesmo critério do servidor, para o botão não prometer o que será recusado. */
export function draftIsValid(draft: NodeDraft): boolean {
  const filled = draft.options.filter((o) => o.label.trim());
  if (!draft.promptText.trim() || filled.length === 0) return false;
  // Sem lacuna entre opções preenchidas (§6).
  const labels = draft.options.map((o) => o.label.trim());
  const firstEmpty = labels.findIndex((l) => !l);
  if (firstEmpty !== -1 && labels.slice(firstEmpty).some((l) => l)) return false;
  return filled.length <= MAX_OPTIONS_PER_NODE;
}

export function NodeEditor({
  draft,
  busy,
  editing,
  isRoot,
  patientId,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: NodeDraft;
  busy: boolean;
  /** Revisando um rascunho existente, em vez de criar do zero. */
  editing: boolean;
  isRoot: boolean;
  /** Paciente da sessão — o ditado é autorizado por vínculo com ele. */
  patientId: number;
  onChange: (draft: NodeDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<NodeDraft>) => onChange({ ...draft, ...patch });
  const setOption = (index: number, patch: Partial<OptionDraft>) =>
    set({
      options: draft.options.map((o, i) => (i === index ? { ...o, ...patch } : o)),
    });

  const valid = draftIsValid(draft);

  // Só o título do nível. Os rótulos das opções ("FAMÍLIA", "SAÚDE") e as
  // frases finais ficam de fora desta primeira versão de propósito: são campos
  // curtos dentro de uma lista repetida, e um microfone por linha encheria a
  // tela de controles para ganhar pouco.
  const ditado = useDictationField({
    patientId,
    valor: draft.promptText,
    aoMudar: (texto) => set({ promptText: texto }),
    limite: MAX_PROMPT_LEN,
    bloqueado: busy,
  });

  return (
    <section className="flex w-full flex-col gap-5">
      <div>
        <h1 className="text-2xl font-medium tracking-tight sm:text-3xl">
          {editing
            ? "Editar este nível"
            : isRoot
              ? "Criar o primeiro nível"
              : "Criar o próximo nível"}
        </h1>
        <p className="mt-2 text-ink-soft">
          Escreva o título e até {MAX_OPTIONS_PER_NODE} opções. O paciente
          escolhe uma delas com um sinal; você registra o que observou. As três
          opções aparecem com o mesmo peso visual.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="oc-prompt" className="text-sm font-medium text-ink-soft">
          Título ou pergunta do nível
        </label>
        <textarea
          id="oc-prompt"
          value={draft.promptText}
          maxLength={MAX_PROMPT_LEN}
          rows={2}
          autoFocus
          onChange={(e) => set({ promptText: e.target.value })}
          placeholder="Ex.: Sobre qual assunto deseja conversar?"
          className="w-full resize-y rounded-2xl border border-line bg-card px-5 py-4 text-xl leading-relaxed text-ink placeholder:text-ink-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        />
        <p
          aria-live="polite"
          className={`text-right text-sm tabular-nums ${
            MAX_PROMPT_LEN - draft.promptText.length < 30
              ? "text-nao"
              : "text-ink-soft"
          }`}
        >
          {draft.promptText.length} / {MAX_PROMPT_LEN}
        </p>
        <DictationButton ditado={ditado} rotuloDoCampo="o título do nível" />
      </div>

      <fieldset className="flex flex-col gap-4 rounded-2xl border border-line bg-card/60 px-5 py-4">
        {/* Nome distinto do grupo que o PACIENTE vê ("Opções apresentadas ao
            paciente"): são superfícies diferentes e não podem se confundir
            para quem navega por leitor de tela. */}
        <legend className="px-1 text-sm font-medium text-ink-soft">
          Opções deste nível
        </legend>
        {draft.options.map((option, index) => (
          <div key={index} className="flex flex-col gap-2">
            <label
              htmlFor={`oc-opcao-${index + 1}`}
              className="text-sm font-medium text-ink-soft"
            >
              Opção {index + 1}
              {index > 0 ? " (opcional)" : ""}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id={`oc-opcao-${index + 1}`}
                type="text"
                value={option.label}
                maxLength={MAX_OPTION_LABEL_LEN}
                onChange={(e) => setOption(index, { label: e.target.value })}
                placeholder={
                  index === 0 ? "Ex.: FAMÍLIA" : index === 1 ? "Ex.: SAÚDE" : "Ex.: ROTINA"
                }
                className="min-w-0 flex-1 rounded-xl border border-line bg-card px-4 py-3 text-lg text-ink placeholder:text-ink-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              />
              {draft.options.length > 1 && (
                <Control
                  onClick={() =>
                    set({ options: draft.options.filter((_, i) => i !== index) })
                  }
                  disabled={busy}
                >
                  Remover
                </Control>
              )}
            </div>
            <label className="flex items-start gap-2 text-sm text-ink-soft">
              <input
                type="checkbox"
                checked={option.isTerminal === true}
                onChange={(e) =>
                  setOption(index, {
                    isTerminal: e.target.checked,
                    finalStatementDraft: e.target.checked
                      ? (option.finalStatementDraft ?? "")
                      : null,
                  })
                }
                className="mt-0.5 size-4 accent-[var(--color-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              />
              <span>
                Esta opção encerra o caminho e abre a mensagem em construção
              </span>
            </label>
            {option.isTerminal && (
              <input
                type="text"
                value={option.finalStatementDraft ?? ""}
                maxLength={MAX_STATEMENT_LEN}
                onChange={(e) =>
                  setOption(index, { finalStatementDraft: e.target.value })
                }
                aria-label={`Frase final da opção ${index + 1}`}
                placeholder="Ex.: Estou sentindo dor na perna."
                className="rounded-xl border border-line bg-card px-4 py-2.5 text-ink placeholder:text-ink-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              />
            )}
          </div>
        ))}
        {draft.options.length < MAX_OPTIONS_PER_NODE && (
          <div>
            <Control
              onClick={() => set({ options: [...draft.options, { label: "" }] })}
              disabled={busy}
            >
              + Adicionar opção
            </Control>
          </div>
        )}
      </fieldset>

      <fieldset className="rounded-2xl border border-line bg-card/60 px-5 py-4">
        <legend className="px-1 text-sm font-medium text-ink-soft">
          Assunto sensível
        </legend>
        <div className="flex items-start gap-3 text-ink">
          <input
            id="oc-sensivel"
            type="checkbox"
            checked={draft.isSensitive}
            aria-describedby="oc-sensivel-ajuda"
            onChange={(e) =>
              set({
                isSensitive: e.target.checked,
                sensitiveCategory: e.target.checked
                  ? draft.sensitiveCategory
                  : null,
              })
            }
            className="mt-1 size-5 accent-[var(--color-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          />
          <div>
            <label htmlFor="oc-sensivel" className="cursor-pointer">
              Este nível trata de um assunto sensível
            </label>
            <p id="oc-sensivel-ajuda" className="text-sm text-ink-soft">
              A frase final deste caminho exigirá reconfirmação reforçada antes
              de ser registrada.
            </p>
          </div>
        </div>
        {draft.isSensitive && (
          <div className="mt-4">
            <label
              htmlFor="oc-categoria"
              className="block text-sm font-medium text-ink-soft"
            >
              Categoria
            </label>
            <select
              id="oc-categoria"
              value={draft.sensitiveCategory ?? ""}
              onChange={(e) =>
                set({
                  sensitiveCategory: (e.target.value ||
                    null) as SensitiveCategory | null,
                })
              }
              className="mt-1.5 w-full rounded-xl border border-line bg-card px-4 py-2.5 text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:w-auto"
            >
              <option value="">Não especificar</option>
              {SENSITIVE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {SENSITIVE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Primary onClick={onSubmit} disabled={!valid || busy}>
          {busy ? "Salvando…" : editing ? "Salvar alterações" : "Continuar"}
        </Primary>
        <Control onClick={onCancel} disabled={busy}>
          Cancelar
        </Control>
      </div>
      {!valid && (
        <p className="text-sm text-ink-soft">
          É preciso um título e ao menos uma opção preenchida, sem deixar uma
          opção vazia entre opções preenchidas.
        </p>
      )}
    </section>
  );
}

/** Revisão final antes de apresentar, com o lápis para voltar a editar (§26). */
export function NodeReview({
  draft,
  busy,
  onEdit,
  onPresent,
  onCancel,
}: {
  draft: NodeDraft;
  busy: boolean;
  onEdit: () => void;
  onPresent: () => void;
  onCancel: () => void;
}) {
  const filled = draft.options.filter((o) => o.label.trim());
  return (
    <section className="flex w-full flex-col gap-5">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-ink-soft">
          Revisar antes de apresentar
        </p>
        <blockquote className="mt-3 text-3xl font-medium leading-snug tracking-tight sm:text-4xl">
          {draft.promptText}
        </blockquote>
      </div>
      <ol className="flex flex-col gap-2">
        {filled.map((option, i) => (
          <li
            key={i}
            className="flex flex-wrap items-baseline gap-2 rounded-xl border border-line bg-card/60 px-4 py-3"
          >
            <span className="font-semibold tabular-nums text-ink-mute">
              {i + 1}.
            </span>
            <span className="min-w-0 flex-1 text-lg text-ink">{option.label}</span>
            {option.isTerminal && (
              <span className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-mute">
                encerra o caminho
              </span>
            )}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <Primary onClick={onPresent} disabled={busy}>
          {busy ? "Apresentando…" : "Apresentar ao paciente"}
        </Primary>
        <Control onClick={onEdit} disabled={busy}>
          ✎ Editar
        </Control>
        <Control onClick={onCancel} disabled={busy}>
          Cancelar nível
        </Control>
      </div>
      <p className="text-sm text-ink-soft">
        Depois de apresentado, este conteúdo não é reescrito: para corrigi-lo
        você criará uma versão corrigida, e a original continua registrada.
      </p>
    </section>
  );
}
