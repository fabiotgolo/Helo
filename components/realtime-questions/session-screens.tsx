"use client";

// ——— Perguntas em tempo real: as telas da sessão ———
//
// Superfícies de APRESENTAÇÃO, sem estado próprio: cada uma recebe por props o
// que mostrar e o que chamar. Quem decide o que aparece é session.tsx, que lê o
// estado do servidor — nenhuma destas telas escolhe o próximo passo da conversa.
//
// Elas vivem fora de session.tsx para que a casca continue sendo casca: com a
// pergunta fechada, a conversa por opções, o contexto da sessão, a interpretação
// do cuidador e os controles do paciente convivendo na mesma sessão, o
// orquestrador precisa caber numa leitura.

import { ModalShell } from "@/components/modal-shell";
import { Control, Primary } from "@/components/realtime-questions/ui";
import { DictationButton } from "@/components/voice/dictation-button";
import { useDictationField } from "@/lib/voice/use-dictation";
import {
  SEMANTIC_RESPONSE_LABELS,
  SENSITIVE_CATEGORIES,
  SENSITIVE_CATEGORY_LABELS,
  type ConversationQuestionTurn,
  type SemanticResponse,
  type SensitiveCategory,
} from "@/lib/realtime-question-types";

/** Mesmo teto do servidor (MAX_QUESTION_LEN) — o contador não mente. */
export const MAX_QUESTION = 500;

export function ErrorBanner({
  message,
  canReload,
  onRetry,
  onReload,
  onDismiss,
}: {
  message: string;
  canReload: boolean;
  onRetry: (() => void) | null;
  onReload: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-nao/40 bg-nao-soft px-5 py-3 text-nao"
    >
      <span className="min-w-0 flex-1 text-sm font-medium">
        <span aria-hidden="true">⚠ </span>
        {message} O registro <strong>não</strong> foi concluído.
      </span>
      {onRetry && <Control onClick={onRetry}>Tentar novamente</Control>}
      {canReload && <Control onClick={onReload}>Recarregar sessão</Control>}
      <Control onClick={onDismiss}>Fechar</Control>
    </div>
  );
}

export function ComposeScreen({
  draft,
  busy,
  editing,
  cancelable,
  patientId,
  onChange,
  onContinue,
  onCancel,
  onOptionConversation,
  onCaregiverInterpretation,
  onDictated,
}: {
  draft: string;
  busy: boolean;
  editing: boolean;
  cancelable: boolean;
  /** Paciente da sessão — o ditado é autorizado por vínculo com ele. */
  patientId: number;
  onChange: (v: string) => void;
  onContinue: () => void;
  onCancel: () => void;
  /** Entrada manual da conversa por opções. Ausente ao editar uma pergunta. */
  onOptionConversation: (() => void) | null;
  /** Registrar o que o cuidador entendeu (Fase 4.2). */
  onCaregiverInterpretation: (() => void) | null;
  /**
   * Uma transcrição acabou de entrar no campo (Fase 5.2A, precisada na 5.2B).
   * `textoAntes` é o que havia ali no instante anterior — é ele que decide se a
   * pergunta NASCEU por voz ou se a voz apenas completou algo já digitado.
   */
  onDictated: (info: { transcricao: string; textoAntes: string }) => void;
}) {
  const text = draft.trim();
  const remaining = MAX_QUESTION - draft.length;
  // O ditado escreve pelo mesmo `onChange` do teclado. Daqui para baixo, uma
  // pergunta falada e uma digitada são a mesma coisa — e o `Continuar` segue
  // sendo o único jeito de a pergunta existir.
  const ditado = useDictationField({
    patientId,
    valor: draft,
    aoMudar: onChange,
    // O que sobe é a transcrição CRUA e o estado anterior do campo, não o
    // resultado da soma. `originalText` precisa significar "o que a voz
    // produziu"; se o cuidador já havia digitado metade, a metade digitada é
    // dele e não pode ser atribuída ao microfone.
    aoDitar: ({ transcricao, textoAntes }) => onDictated({ transcricao, textoAntes }),
    limite: MAX_QUESTION,
    bloqueado: busy,
  });
  return (
    <section className="flex w-full flex-col gap-4">
      <div>
        <h1 className="text-2xl font-medium tracking-tight sm:text-3xl">
          {editing ? "Editar a pergunta" : "Escreva a pergunta"}
        </h1>
        <p className="mt-2 text-ink-soft">
          Você formula a pergunta. O paciente responde com um gesto, e você
          registra o que observou.
        </p>
      </div>
      <label htmlFor="rtq-pergunta" className="sr-only">
        Pergunta para o paciente
      </label>
      <textarea
        id="rtq-pergunta"
        value={draft}
        maxLength={MAX_QUESTION}
        rows={3}
        autoFocus
        onChange={(e) => onChange(e.target.value)}
        placeholder="Ex.: O senhor está com sede?"
        className="w-full resize-y rounded-2xl border border-line bg-card px-5 py-4 text-xl leading-relaxed text-ink placeholder:text-ink-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      />
      <p
        aria-live="polite"
        className={`text-right text-sm tabular-nums ${
          remaining < 50 ? "text-nao" : "text-ink-soft"
        }`}
      >
        {draft.length} / {MAX_QUESTION}
      </p>
      <DictationButton ditado={ditado} rotuloDoCampo="a pergunta" />
      <div className="flex flex-wrap items-center gap-3">
        <Primary onClick={onContinue} disabled={!text || busy}>
          {busy ? "Salvando…" : "Continuar"}
        </Primary>
        {onOptionConversation && (
          <Control onClick={onOptionConversation} disabled={busy}>
            Conversa por opções
          </Control>
        )}
        {onCaregiverInterpretation && (
          <Control onClick={onCaregiverInterpretation} disabled={busy}>
            Registrar o que entendi
          </Control>
        )}
        {cancelable && <Control onClick={onCancel}>Cancelar</Control>}
      </div>
    </section>
  );
}

export function ReviewScreen({
  text,
  sensitive,
  category,
  busy,
  onEdit,
  onSensitiveChange,
  onCategoryChange,
  onPresent,
  onCancel,
}: {
  text: string;
  sensitive: boolean;
  category: SensitiveCategory | null;
  busy: boolean;
  onEdit: () => void;
  onSensitiveChange: (v: boolean) => void;
  onCategoryChange: (v: SensitiveCategory | null) => void;
  onPresent: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="flex w-full flex-col gap-5">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-ink-soft">
          Revisar antes de apresentar
        </p>
        <blockquote className="mt-3 text-3xl font-medium leading-snug tracking-tight sm:text-4xl">
          {text}
        </blockquote>
      </div>

      <fieldset className="rounded-2xl border border-line bg-card/60 px-5 py-4">
        <legend className="px-1 text-sm font-medium text-ink-soft">
          Assunto sensível
        </legend>
        <div className="flex items-start gap-3 text-ink">
          <input
            id="rtq-sensivel"
            type="checkbox"
            checked={sensitive}
            aria-describedby="rtq-sensivel-ajuda"
            onChange={(e) => onSensitiveChange(e.target.checked)}
            className="mt-1 size-5 accent-[var(--color-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          />
          <div>
            <label htmlFor="rtq-sensivel" className="cursor-pointer">
              Esta pergunta trata de um assunto sensível
            </label>
            <p id="rtq-sensivel-ajuda" className="text-sm text-ink-soft">
              A resposta exigirá reconfirmação com o paciente antes de ser
              registrada.
            </p>
          </div>
        </div>
        {sensitive && (
          <div className="mt-4">
            <label
              htmlFor="rtq-categoria"
              className="block text-sm font-medium text-ink-soft"
            >
              Categoria
            </label>
            <select
              id="rtq-categoria"
              value={category ?? ""}
              onChange={(e) =>
                onCategoryChange(
                  (e.target.value || null) as SensitiveCategory | null
                )
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
        <Primary onClick={onPresent} disabled={busy}>
          {busy ? "Apresentando…" : "Apresentar ao paciente"}
        </Primary>
        <Control onClick={onEdit} disabled={busy}>
          Editar
        </Control>
        <Control onClick={onCancel} disabled={busy}>
          Cancelar pergunta
        </Control>
      </div>
      <p className="text-sm text-ink-soft">
        Depois de apresentada, a pergunta não pode ser reescrita — para mudar o
        texto, cancele e faça uma nova pergunta.
      </p>
    </section>
  );
}

export function AwaitingControls({
  busy,
  onUncertain,
  onRepresent,
  onNoResponse,
}: {
  busy: boolean;
  onUncertain: () => void;
  onRepresent: () => void;
  onNoResponse: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-sm text-ink-soft">
        Toque na resposta que corresponde ao gesto observado. Nada é registrado
        como definitivo antes da sua confirmação.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Control onClick={onUncertain} disabled={busy}>
          Não consegui identificar o gesto
        </Control>
        <Control onClick={onRepresent} disabled={busy}>
          Reapresentar pergunta
        </Control>
        <Control onClick={onNoResponse} disabled={busy}>
          Registrar ausência de resposta
        </Control>
      </div>
    </div>
  );
}

export function ProvisionalPanel({
  response,
  sensitive,
  correcting,
  busy,
  onConfirm,
  onCorrect,
  onCancelSelection,
}: {
  response: SemanticResponse;
  sensitive: boolean;
  correcting: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCorrect: () => void;
  onCancelSelection: () => void;
}) {
  return (
    <section
      aria-live="polite"
      className="flex flex-col items-center gap-4 rounded-3xl border border-line bg-card/80 px-6 py-6"
    >
      <p className="text-2xl font-medium">
        Resposta observada: {SEMANTIC_RESPONSE_LABELS[response]}
      </p>
      <p className="max-w-xl text-center text-sm text-ink-soft">
        {correcting
          ? "Toque na resposta que corresponde ao gesto observado. A seleção anterior fica registrada no histórico."
          : "Confirmar significa que o botão selecionado corresponde ao gesto que você observou — não que você concorda com a resposta ou a interpreta."}
        {sensitive && !correcting
          ? " Este assunto é sensível: haverá uma reconfirmação."
          : ""}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Primary onClick={onConfirm} disabled={busy || correcting}>
          Confirmar
        </Primary>
        <Control onClick={onCorrect} disabled={busy || correcting}>
          Corrigir
        </Control>
        <Control onClick={onCancelSelection} disabled={busy}>
          Cancelar seleção
        </Control>
      </div>
    </section>
  );
}

export function ReconfirmPanel({
  response,
  busy,
  onReconfirm,
  onCorrect,
  onFailedReconfirmation,
}: {
  response: SemanticResponse;
  busy: boolean;
  onReconfirm: () => void;
  onCorrect: () => void;
  onFailedReconfirmation: () => void;
}) {
  return (
    <section
      aria-live="polite"
      className="flex flex-col items-center gap-4 rounded-3xl border border-talvez/40 bg-talvez-soft px-6 py-6"
    >
      <p className="text-sm font-semibold uppercase tracking-widest text-talvez">
        Assunto sensível — reconfirmação
      </p>
      <p className="text-2xl font-medium text-ink">
        A resposta observada foi {SEMANTIC_RESPONSE_LABELS[response]}.
      </p>
      <p className="max-w-xl text-center text-ink-soft">
        Confirme novamente com o paciente antes de registrar esta resposta.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Primary onClick={onReconfirm} disabled={busy}>
          Resposta reconfirmada
        </Primary>
        <Control onClick={onCorrect} disabled={busy}>
          Corrigir resposta
        </Control>
        <Control onClick={onFailedReconfirmation} disabled={busy}>
          Não foi possível reconfirmar
        </Control>
      </div>
    </section>
  );
}

export function UncertainScreen({
  busy,
  onAwait,
  onRepresent,
  onPause,
  onNoResponse,
  onCancel,
}: {
  busy: boolean;
  onAwait: () => void;
  onRepresent: () => void;
  onPause: () => void;
  onNoResponse: () => void;
  onCancel: () => void;
}) {
  return (
    <section
      aria-live="polite"
      className="flex flex-col items-center gap-4 rounded-3xl border border-line bg-card/80 px-6 py-8 text-center"
    >
      <p className="text-2xl font-medium">Gesto incerto registrado</p>
      <p className="max-w-xl text-ink-soft">
        Nenhuma resposta foi atribuída. Este registro não conta como resposta do
        paciente — ele existe para preservar a dúvida, não para resolvê-la.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Primary onClick={onAwait} disabled={busy}>
          Aguardar novo gesto
        </Primary>
        <Control onClick={onRepresent} disabled={busy}>
          Reapresentar pergunta
        </Control>
        <Control onClick={onPause} disabled={busy}>
          Pausar sessão
        </Control>
        <Control onClick={onNoResponse} disabled={busy}>
          Registrar ausência de resposta
        </Control>
        <Control onClick={onCancel} disabled={busy}>
          Cancelar pergunta
        </Control>
      </div>
    </section>
  );
}

export function IdleScreen({
  lastTurn,
  busy,
  onNewQuestion,
  onOptionConversation,
  onCaregiverInterpretation,
  onFinish,
}: {
  lastTurn: ConversationQuestionTurn | null;
  busy: boolean;
  onNewQuestion: () => void;
  /**
   * Entrada MANUAL e discreta da conversa por opções — fallback, validação e
   * teste. A ativação automática pela IA virá por shouldOpenOptionFlow, não
   * por este botão.
   */
  onOptionConversation: () => void;
  /** Registrar o que o cuidador entendeu (Fase 4.2). */
  onCaregiverInterpretation: () => void;
  onFinish: () => void;
}) {
  return (
    <section className="flex w-full flex-col items-center gap-6 text-center">
      {lastTurn && <TurnSummary turn={lastTurn} />}
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Primary onClick={onNewQuestion} disabled={busy}>
          Fazer nova pergunta
        </Primary>
        <Control onClick={onOptionConversation} disabled={busy}>
          Conversa por opções
        </Control>
        <Control onClick={onCaregiverInterpretation} disabled={busy}>
          Registrar o que entendi
        </Control>
        <Control onClick={onFinish} disabled={busy}>
          Encerrar sessão
        </Control>
      </div>
      <p className="max-w-md text-sm text-ink-mute">
        Na conversa por opções o paciente escolhe entre até três alternativas.
        Ali os sinais dele significam opção 1, 2 e 3 — não SIM, TALVEZ e NÃO.
      </p>
    </section>
  );
}

/** Resumo discreto do turno encerrado — o que foi perguntado e o resultado. */
function TurnSummary({ turn }: { turn: ConversationQuestionTurn }) {
  const resultado =
    turn.status === "CONFIRMED" && turn.confirmedResponse
      ? `Resposta confirmada: ${SEMANTIC_RESPONSE_LABELS[turn.confirmedResponse]}`
      : turn.status === "NO_RESPONSE"
        ? "Resultado: Sem resposta"
        : "Resultado: Pergunta cancelada";
  return (
    <div
      aria-live="polite"
      className="w-full rounded-2xl border border-line bg-card/70 px-5 py-4 text-left"
    >
      <p className="text-ink-soft">
        Pergunta:{" "}
        <span className="text-ink">
          {turn.presentedText || turn.reviewedText}
        </span>
      </p>
      <p className="mt-1 font-medium text-ink">{resultado}</p>
    </div>
  );
}

export function PausedScreen({
  busy,
  onResume,
  onExit,
}: {
  busy: boolean;
  onResume: () => void;
  onExit: () => void;
}) {
  return (
    <section className="flex w-full flex-col items-center gap-5 rounded-3xl border border-line bg-card/80 px-6 py-10 text-center">
      <p className="text-3xl font-medium">Sessão pausada</p>
      <p className="max-w-md text-ink-soft">
        Nenhuma pergunta ou resposta é registrada enquanto a sessão está
        pausada. Tudo o que já foi registrado continua guardado.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Primary onClick={onResume} disabled={busy}>
          ▶ Retomar sessão
        </Primary>
        <Control onClick={onExit} disabled={busy}>
          Sair
        </Control>
      </div>
    </section>
  );
}

export function FinishedScreen({
  status,
  turns,
  onLeave,
}: {
  status: "COMPLETED" | "ABANDONED" | "ACTIVE" | "PAUSED";
  turns: ConversationQuestionTurn[];
  onLeave: () => void;
}) {
  const abandonada = status === "ABANDONED";
  const confirmadas = turns.filter((t) => t.status === "CONFIRMED").length;
  const semResposta = turns.filter((t) => t.status === "NO_RESPONSE").length;
  return (
    <section className="flex w-full flex-col items-center gap-4 text-center">
      <p className="text-3xl font-medium">
        {abandonada ? "Sessão abandonada" : "Sessão concluída"}
      </p>
      <p className="max-w-md text-ink-soft">
        {abandonada
          ? "A sessão foi encerrada sem conclusão formal. As perguntas e respostas registradas foram preservadas."
          : "As interações desta sessão foram registradas."}
      </p>
      <p className="text-ink-soft">
        {turns.length} {turns.length === 1 ? "pergunta" : "perguntas"} ·{" "}
        {confirmadas} {confirmadas === 1 ? "confirmada" : "confirmadas"} ·{" "}
        {semResposta} sem resposta
      </p>
      <Primary onClick={onLeave}>Voltar</Primary>
    </section>
  );
}

export function ExitModal({
  busy,
  onContinue,
  onPause,
  onComplete,
  onAbandon,
}: {
  busy: boolean;
  onContinue: () => void;
  onPause: () => void;
  onComplete: () => void;
  onAbandon: () => void;
}) {
  return (
    <ModalShell
      onClose={onContinue}
      label="O que deseja fazer com esta sessão?"
      disableDismiss={busy}
    >
      <h2 className="text-xl font-medium">
        O que deseja fazer com esta sessão?
      </h2>
      <p className="mt-2 text-sm text-ink-soft">
        Perguntas sem resposta continuam sem resposta — nenhuma delas vira um
        NÃO, e nenhuma seleção provisória vira confirmada.
      </p>
      <div className="mt-6 flex flex-col gap-2">
        <Primary onClick={onContinue} disabled={busy}>
          Continuar sessão
        </Primary>
        <Control onClick={onPause} disabled={busy}>
          Pausar para retomar depois
        </Control>
        <Control onClick={onComplete} disabled={busy}>
          Concluir sessão
        </Control>
        <Control onClick={onAbandon} disabled={busy}>
          Abandonar sessão
        </Control>
      </div>
    </ModalShell>
  );
}
