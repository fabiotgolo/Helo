"use client";

// ——— Compositor da mensagem (§17, §19) e confirmação da frase (§20) ———
//
// O compositor é discreto: mostra o caminho escolhido, a frase em construção e
// o estado da composição. Enquanto não houver confirmação do paciente, ele diz
// exatamente isso — "mensagem em construção" — para que ninguém leia um
// rascunho como comunicação.
//
// A frase nasce de duas formas, e SÓ dessas duas: da frase associada à opção
// terminal, ou escrita pelo assistente a partir do caminho confirmado. Não há
// IA em lugar nenhum deste arquivo.

import {
  Control,
  EditButton,
  Primary,
  Selo,
} from "@/components/realtime-questions/option-conversation/ui";
import { GestureOptionsBar } from "@/components/gesture-options-bar";
import { useAnswerChoices } from "@/components/realtime-questions/question-stage";
import { MAX_STATEMENT_LEN } from "@/lib/option-conversation-types";
import type { OptionConversationFinalStatement } from "@/lib/option-conversation-types";
import {
  SEMANTIC_RESPONSE_LABELS,
  SENSITIVE_CATEGORY_LABELS,
  type PatientResponseProfile,
  type SemanticResponse,
} from "@/lib/realtime-question-types";

/** Caminho + frase em construção + estado. Sempre visível durante a composição. */
export function Composer({
  trailLabels,
  statement,
  busy,
  onEdit,
  children,
}: {
  trailLabels: string[];
  statement: OptionConversationFinalStatement | null;
  busy: boolean;
  /** Ausente quando a frase já foi apresentada — daí a edição vira versão nova. */
  onEdit: (() => void) | null;
  children?: React.ReactNode;
}) {
  const confirmada = statement?.status === "CONFIRMED";
  const rejeitada = statement?.status === "REJECTED";
  return (
    <section className="flex w-full flex-col gap-4 rounded-3xl border border-line bg-card/70 px-5 py-5">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-widest text-ink-soft">
          Caminho
        </span>
        <p className="text-ink">
          {trailLabels.length > 0 ? trailLabels.join(" › ") : "—"}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-ink-soft">
            {confirmada ? "Mensagem confirmada" : "Mensagem em construção"}
          </span>
          {onEdit && (
            <EditButton
              label="a mensagem em construção"
              onClick={onEdit}
              disabled={busy}
            />
          )}
        </div>
        <p className="text-xl font-medium leading-snug text-ink">
          {statement ? statement.currentText : "—"}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <p aria-live="polite" className="text-sm text-ink-soft">
          {confirmada
            ? "Confirmada pelo paciente."
            : rejeitada
              ? "Rejeitada pelo paciente. Não é uma comunicação confirmada."
              : "Mensagem em construção, aguardando confirmação do paciente."}
        </p>
        {statement?.isSensitive && (
          <Selo>
            Sensível
            {statement.sensitiveCategory
              ? ` · ${SENSITIVE_CATEGORY_LABELS[statement.sensitiveCategory]}`
              : ""}
          </Selo>
        )}
        {statement && statement.editCount > 0 && (
          <Selo>
            {statement.editCount}{" "}
            {statement.editCount === 1 ? "edição" : "edições"}
          </Selo>
        )}
        {statement?.replacesStatementId && <Selo>Versão corrigida</Selo>}
        {statement?.reusedFromStatementId && <Selo>Reutilizada</Selo>}
      </div>

      {children}
    </section>
  );
}

/** Escrita e edição da frase, antes de apresentar (§19, §27). */
export function StatementEditor({
  text,
  busy,
  suggestion,
  onChange,
  onSubmit,
  onCancel,
}: {
  text: string;
  busy: boolean;
  /** Frase associada à opção terminal, quando houve uma. */
  suggestion: string | null;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <label htmlFor="oc-frase" className="text-sm font-medium text-ink-soft">
        Frase que será apresentada ao paciente
      </label>
      <textarea
        id="oc-frase"
        value={text}
        maxLength={MAX_STATEMENT_LEN}
        rows={3}
        autoFocus
        onChange={(e) => onChange(e.target.value)}
        placeholder="Ex.: Estou sentindo dor na perna."
        className="w-full resize-y rounded-2xl border border-line bg-card px-5 py-4 text-xl leading-relaxed text-ink placeholder:text-ink-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      />
      <div className="flex flex-wrap items-center gap-2">
        {suggestion && suggestion !== text && (
          <Control onClick={() => onChange(suggestion)} disabled={busy}>
            Usar a frase da opção escolhida
          </Control>
        )}
        <p
          aria-live="polite"
          className="ml-auto text-sm tabular-nums text-ink-soft"
        >
          {text.length} / {MAX_STATEMENT_LEN}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Primary onClick={onSubmit} disabled={!text.trim() || busy}>
          {busy ? "Salvando…" : "Apresentar ao paciente"}
        </Primary>
        <Control onClick={onCancel} disabled={busy}>
          Cancelar
        </Control>
      </div>
    </div>
  );
}

/**
 * Confirmação da frase (§20), em FINAL_STATEMENT_CONFIRMATION.
 *
 * Aqui — e só aqui, junto da pergunta fechada — os três sinais voltam a
 * significar SIM, TALVEZ e NÃO. As opções numéricas somem da tela.
 */
export interface StatementActions {
  /** Registra o que o assistente OBSERVOU: SIM, TALVEZ ou NÃO. */
  onRespond: (response: SemanticResponse) => void;
  onConfirm: () => void;
  onReconfirm: () => void;
  onReject: () => void;
  onRepresent: () => void;
  /** TALVEZ · NÃO — cria uma versão corrigida da frase apresentada (§30). */
  onAdjust: () => void;
  /** TALVEZ — volta ao caminho para continuar aprofundando. */
  onDeepen: () => void;
  /** TALVEZ · NÃO — volta um nível do caminho ativo. */
  onBackLevel: () => void;
  /** TALVEZ — descarta a composição, sem confirmar nada. */
  onCancelStatement: () => void;
  /** NÃO — encerra o caminho atual e abre outro. */
  onRestart: () => void;
  /** NÃO — encerra sem nenhuma confirmação. */
  onFinishWithoutConfirming: () => void;
}

export function StatementConfirmation({
  text,
  profile,
  observed,
  sensitive,
  awaitingReconfirmation,
  canGoBack,
  busy,
  actions,
}: {
  text: string;
  profile: PatientResponseProfile | null;
  observed: SemanticResponse | null;
  sensitive: boolean;
  awaitingReconfirmation: boolean;
  canGoBack: boolean;
  busy: boolean;
  actions: StatementActions;
}) {
  const {
    onRespond,
    onConfirm,
    onReconfirm,
    onReject,
    onRepresent,
    onAdjust,
    onDeepen,
    onBackLevel,
    onCancelStatement,
    onRestart,
    onFinishWithoutConfirming,
  } = actions;
  const choices = useAnswerChoices(profile);
  const selectedIndex = observed
    ? choices.findIndex((c) => c.response === observed)
    : null;

  return (
    <section
      aria-live="polite"
      className="flex w-full flex-col items-center gap-8"
    >
      <blockquote className="text-balance text-center text-3xl font-medium leading-tight tracking-tight text-ink sm:text-4xl lg:text-5xl">
        {text}
      </blockquote>

      <GestureOptionsBar
        options={choices.map((c) => ({
          id: c.response,
          emoji: c.emoji,
          label: c.label,
          sublabel: c.sublabel,
        }))}
        tone="neutro"
        size="apresentacao"
        ariaLabel="Respostas possíveis do paciente sobre esta frase"
        selectedIndex={
          selectedIndex != null && selectedIndex >= 0 ? selectedIndex : null
        }
        disabled={busy || awaitingReconfirmation}
        onSelectOption={(option) => onRespond(option.id as SemanticResponse)}
      />

      {observed === null && (
        <p className="text-sm text-ink-soft">
          Toque na resposta que corresponde ao gesto observado. Nada é
          registrado como confirmado antes da sua conferência.
        </p>
      )}

      {/* SIM — o único caminho que confirma. */}
      {observed === "YES" && !awaitingReconfirmation && (
        <div className="flex flex-col items-center gap-3">
          <p className="text-lg text-ink">
            Resposta observada: {SEMANTIC_RESPONSE_LABELS.YES}
          </p>
          {sensitive ? (
            <>
              <p className="max-w-xl text-center text-sm text-ink-soft">
                Este assunto é sensível: confirme novamente com o paciente antes
                de registrar. Uma única confirmação não conclui.
              </p>
              <Primary onClick={onReconfirm} disabled={busy}>
                Reconfirmar com o paciente
              </Primary>
            </>
          ) : (
            <Primary onClick={onConfirm} disabled={busy}>
              Confirmar a frase
            </Primary>
          )}
        </div>
      )}

      {observed === "YES" && awaitingReconfirmation && (
        <div className="flex flex-col items-center gap-3 rounded-3xl border border-talvez/40 bg-talvez-soft px-6 py-5">
          <p className="text-sm font-semibold uppercase tracking-widest text-talvez">
            Assunto sensível — reconfirmação
          </p>
          <p className="max-w-xl text-center text-ink-soft">
            O paciente reconfirmou esta frase?
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Primary onClick={onConfirm} disabled={busy}>
              Resposta reconfirmada
            </Primary>
            <Control onClick={onRepresent} disabled={busy}>
              Apresentar a frase de novo
            </Control>
          </div>
        </div>
      )}

      {/* TALVEZ — NÃO confirma. Ajustar, aprofundar, voltar ou cancelar (§20). */}
      {observed === "MAYBE" && (
        <NotConfirmedPanel
          response="MAYBE"
          explanation="O paciente indicou que algo precisa mudar."
        >
          <Control onClick={onAdjust} disabled={busy}>
            Ajustar frase
          </Control>
          <Control onClick={onDeepen} disabled={busy}>
            Aprofundar assunto
          </Control>
          {canGoBack && (
            <Control onClick={onBackLevel} disabled={busy}>
              Voltar um nível
            </Control>
          )}
          <Control onClick={onCancelStatement} disabled={busy}>
            Cancelar frase
          </Control>
          <Control onClick={onRepresent} disabled={busy}>
            Apresentar de novo
          </Control>
        </NotConfirmedPanel>
      )}

      {/* NÃO — NÃO confirma. Rejeitar é um ato explícito, como confirmar (§20). */}
      {observed === "NO" && (
        <NotConfirmedPanel
          response="NO"
          explanation="Registrar como rejeitada preserva a recusa do paciente — ela nunca será tratada como comunicação confirmada."
        >
          <Primary onClick={onReject} disabled={busy}>
            Registrar como rejeitada
          </Primary>
          <Control onClick={onDeepen} disabled={busy}>
            Voltar ao caminho
          </Control>
          <Control onClick={onAdjust} disabled={busy}>
            Reformular frase
          </Control>
          <Control onClick={onRestart} disabled={busy}>
            Reiniciar conversa
          </Control>
          <Control onClick={onFinishWithoutConfirming} disabled={busy}>
            Encerrar sem confirmar
          </Control>
        </NotConfirmedPanel>
      )}
    </section>
  );
}

/**
 * Moldura comum de TALVEZ e NÃO. Existe para que os dois digam, com o mesmo
 * peso e nas mesmas palavras, a única coisa que importa aqui: a frase NÃO foi
 * confirmada.
 */
function NotConfirmedPanel({
  response,
  explanation,
  children,
}: {
  response: SemanticResponse;
  explanation: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-3xl border border-line bg-card/80 px-6 py-5">
      <p className="text-lg text-ink">
        Resposta observada: {SEMANTIC_RESPONSE_LABELS[response]}
      </p>
      <p className="max-w-xl text-center text-sm text-ink-soft">
        A frase <strong>não</strong> foi confirmada. {explanation}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {children}
      </div>
    </div>
  );
}
