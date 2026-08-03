"use client";

// ——— Controles diretos do paciente (Fase 4.7) ———
//
// Até aqui, quem controlava o ritmo da conversa era sempre o cuidador. Este
// painel devolve ao paciente cinco pedidos: pausar, repetir, dizer que não
// entendeu, mudar de assunto e encerrar.
//
// AS DUAS REGRAS QUE DÃO FORMA A ESTE ARQUIVO:
//
//   1. São cinco comandos e três gestos. Por isso há dois níveis, e por isso o
//      terceiro botão do nível 1 é MAIS CONTROLES — um comando de verdade, que
//      o paciente escolhe e o cuidador confere.
//   2. Nos níveis, os três sinais significam comando 1, 2 e 3 — nunca SIM,
//      TALVEZ e NÃO. Os rótulos semânticos voltam SÓ na pergunta fechada
//      "Deseja encerrar a conversa?", que é a única pergunta fechada daqui.
//
// O painel SOBREPÕE a conversa, não a substitui: abrir não altera, não conclui
// e não apaga nada, e "Voltar para a conversa" devolve a tela exatamente como
// estava — inclusive o texto digitado e a seleção provisória.

import { GestureOptionsBar } from "@/components/gesture-options-bar";
import {
  useAnswerChoices,
  useSignalAnchors,
} from "@/components/realtime-questions/question-stage";
import { Control, InteractionModeBadge, Primary } from "@/components/realtime-questions/ui";
import {
  PATIENT_COMMAND_LABELS,
  PATIENT_COMMAND_LEVELS,
  PATIENT_COMMAND_MEANINGS,
  type PatientCommand,
  type PatientControlRequest,
} from "@/lib/patient-control-types";
import type {
  PatientResponseProfile,
  SemanticResponse,
} from "@/lib/realtime-question-types";

export interface ControlChoice {
  command: PatientCommand;
  emoji: string;
  label: string;
  sublabel: string;
}

/**
 * Comando → âncora física, na mesma ordem de sempre:
 *   comando 1 → âncora de YES · comando 2 → MAYBE · comando 3 → NO
 *
 * Espelha `useOptionChoices`: o gesto do paciente é o mesmo, muda só o texto.
 */
export function useControlChoices(
  profile: PatientResponseProfile | null,
  commands: readonly PatientCommand[]
): ControlChoice[] {
  const anchors = useSignalAnchors(profile);
  return commands.map((command, i) => ({
    command,
    emoji: anchors[i]?.emoji ?? anchors[0].emoji,
    label: PATIENT_COMMAND_LABELS[command],
    sublabel: anchors[i]?.sublabel ?? "",
  }));
}

/** Botão discreto e permanente, no rodapé da sessão. */
export function PatientControlsTrigger({
  onOpen,
  disabled,
}: {
  onOpen: () => void;
  disabled?: boolean;
}) {
  return (
    <Control onClick={onOpen} disabled={disabled}>
      Controles do paciente
    </Control>
  );
}

export interface PatientControlsActions {
  onPresent: () => void;
  onAwaitSelection: () => void;
  onSelect: (command: PatientCommand) => void;
  onChange: (command: PatientCommand) => void;
  onRemoveSelection: () => void;
  onConfirm: () => void;
  onAskEndConfirmation: () => void;
  onRespondEnd: (response: SemanticResponse) => void;
  onExecute: () => void;
  onCancel: () => void;
  onClose: () => void;
}

export function PatientControlsPanel({
  request,
  profile,
  busy,
  actions,
}: {
  request: PatientControlRequest;
  profile: PatientResponseProfile | null;
  busy: boolean;
  actions: PatientControlsActions;
}) {
  const commands = PATIENT_COMMAND_LEVELS[request.level];
  const choices = useControlChoices(profile, commands);
  const answerChoices = useAnswerChoices(profile);
  const selectedIndex = request.provisionalCommand
    ? commands.indexOf(request.provisionalCommand)
    : -1;

  const encerrando = request.status === "END_CONFIRMATION_PENDING";
  const confirmado = request.status === "CONFIRMED";
  const aguardando = request.status === "AWAITING_SELECTION";
  const provisorio = request.status === "PROVISIONAL_SELECTION";

  return (
    <div
      role="dialog"
      aria-label="Controles do paciente"
      aria-modal="false"
      className="no-print pointer-events-auto fixed inset-x-0 bottom-0 z-40 mx-auto flex w-full max-w-3xl flex-col gap-5 rounded-t-3xl border border-line bg-card px-5 py-6 shadow-2xl"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium text-ink">Controles do paciente</h2>
        <InteractionModeBadge mode={request.interactionMode} />
      </div>

      {/* ——— Pergunta fechada de encerramento (§29) ——— */}
      {encerrando ? (
        <section aria-live="polite" className="flex flex-col items-center gap-6">
          <p className="text-balance text-center text-2xl font-medium text-ink sm:text-3xl">
            Deseja encerrar a conversa?
          </p>
          <GestureOptionsBar
            options={answerChoices.map((c) => ({
              id: c.response,
              emoji: c.emoji,
              label: c.label,
              sublabel: c.sublabel,
            }))}
            tone="neutro"
            size="apresentacao"
            ariaLabel="Respostas possíveis do paciente sobre encerrar a conversa"
            selectedIndex={
              request.endResponse
                ? answerChoices.findIndex((c) => c.response === request.endResponse)
                : null
            }
            disabled={busy}
            onSelectOption={(o) =>
              actions.onRespondEnd(o.id as SemanticResponse)
            }
          />
          {request.endResponse === "YES" && (
            <div className="flex flex-col items-center gap-2">
              <p className="text-sm text-ink-soft">
                O paciente confirmou que deseja encerrar.
              </p>
              <Primary onClick={actions.onExecute} disabled={busy}>
                Encerrar a conversa
              </Primary>
            </div>
          )}
          {!request.endResponse && (
            <p className="text-sm text-ink-soft">
              Toque na resposta que corresponde ao gesto observado. A conversa só
              termina com o SIM do paciente.
            </p>
          )}
        </section>
      ) : (
        <>
          {/* ——— Os três comandos do nível ——— */}
          <section className="flex flex-col items-center gap-5">
            <GestureOptionsBar
              options={choices.map((c) => ({
                id: c.command,
                emoji: c.emoji,
                label: c.label,
                sublabel: c.sublabel,
              }))}
              tone="neutro"
              size="apresentacao"
              ariaLabel={`Controles do paciente, nível ${request.level}`}
              selectedIndex={selectedIndex >= 0 ? selectedIndex : null}
              disabled={busy || confirmado}
              onSelectOption={(o) => {
                const command = o.id as PatientCommand;
                if (request.provisionalCommand === command) return;
                if (request.provisionalCommand) actions.onChange(command);
                else actions.onSelect(command);
              }}
            />

            {request.status === "OPEN" && (
              <Primary onClick={actions.onPresent} disabled={busy}>
                Apresentar os controles
              </Primary>
            )}

            {request.status === "PRESENTED" && (
              <Primary onClick={actions.onAwaitSelection} disabled={busy}>
                Aguardar o gesto do paciente
              </Primary>
            )}

            {aguardando && (
              <p className="text-sm text-ink-soft">
                Toque no controle que corresponde ao gesto observado. Nada
                acontece antes da sua conferência.
              </p>
            )}
          </section>

          {/* ——— Conferência do gesto observado ——— */}
          {provisorio && request.provisionalCommand && (
            <section className="flex flex-col gap-3 rounded-2xl border border-line bg-bg/40 px-4 py-4">
              <p className="text-sm text-ink">
                Comando observado:{" "}
                <strong>
                  {PATIENT_COMMAND_LABELS[request.provisionalCommand]}
                </strong>{" "}
                <span className="text-ink-soft">
                  (“{PATIENT_COMMAND_MEANINGS[request.provisionalCommand]}”)
                </span>
              </p>
              <div className="flex flex-wrap gap-2">
                <Primary onClick={actions.onConfirm} disabled={busy}>
                  Confirmar comando observado
                </Primary>
                <Control onClick={actions.onRemoveSelection} disabled={busy}>
                  Cancelar seleção
                </Control>
              </div>
            </section>
          )}

          {/* ——— Comando confirmado: o que acontece agora ——— */}
          {confirmado && request.confirmedCommand && (
            <ComandoConfirmado
              command={request.confirmedCommand}
              busy={busy}
              actions={actions}
            />
          )}
        </>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
        <Control onClick={actions.onClose} disabled={busy}>
          Voltar para a conversa
        </Control>
        <span className="text-xs text-ink-soft">
          Fechar não registra resposta do paciente nem altera a conversa.
        </span>
      </div>
    </div>
  );
}

function ComandoConfirmado({
  command,
  busy,
  actions,
}: {
  command: PatientCommand;
  busy: boolean;
  actions: PatientControlsActions;
}) {
  if (command === "MORE_CONTROLS") {
    return (
      <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-bg/40 px-4 py-4">
        <p className="flex-1 text-sm text-ink">
          O paciente pediu para ver os outros controles.
        </p>
        <Primary onClick={actions.onPresent} disabled={busy}>
          Mostrar mais controles
        </Primary>
      </section>
    );
  }

  if (command === "END_CONVERSATION") {
    return (
      <section className="flex flex-col gap-3 rounded-2xl border border-line bg-bg/40 px-4 py-4">
        <p className="text-sm text-ink">
          O paciente pediu para encerrar. Antes de terminar, ele confirma —
          escolher “encerrar” não encerra sozinho.
        </p>
        <div className="flex flex-wrap gap-2">
          <Primary onClick={actions.onAskEndConfirmation} disabled={busy}>
            Perguntar se deseja encerrar
          </Primary>
          <Control onClick={actions.onCancel} disabled={busy}>
            Cancelar pedido
          </Control>
        </div>
      </section>
    );
  }

  const explicacao: Record<
    Exclude<PatientCommand, "MORE_CONTROLS" | "END_CONVERSATION">,
    string
  > = {
    PAUSE: "A sessão será pausada. Nada em curso é concluído ou descartado.",
    REPEAT:
      "O conteúdo atual será apresentado de novo, sem nenhuma alteração no texto.",
    NOT_UNDERSTOOD:
      "Fica registrado que o paciente não compreendeu. O conteúdo não muda, e isso NUNCA é lido como uma recusa.",
    CHANGE_SUBJECT:
      "A interação atual é interrompida e preservada. Respostas já confirmadas continuam valendo.",
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-bg/40 px-4 py-4">
      <p className="text-sm text-ink">
        {explicacao[command as keyof typeof explicacao]}
      </p>
      <div className="flex flex-wrap gap-2">
        <Primary onClick={actions.onExecute} disabled={busy}>
          {PATIENT_COMMAND_LABELS[command]}
        </Primary>
        <Control onClick={actions.onCancel} disabled={busy}>
          Cancelar pedido
        </Control>
      </div>
    </section>
  );
}

/**
 * O que o cuidador pode fazer depois de "NÃO ENTENDI" (§27).
 *
 * Nenhuma destas saídas é automática, e a versão simplificada é ESCRITA pelo
 * cuidador — o Helo não gera texto.
 */
export function NotUnderstoodFollowUp({
  busy,
  onRepeat,
  onSimplify,
  onBackLevel,
  onCancelContent,
  onDismiss,
  canGoBack,
}: {
  busy: boolean;
  onRepeat: () => void;
  onSimplify: (() => void) | null;
  onBackLevel: (() => void) | null;
  onCancelContent: (() => void) | null;
  onDismiss: () => void;
  canGoBack: boolean;
}) {
  return (
    <section
      aria-live="polite"
      className="flex flex-col gap-3 rounded-2xl border border-line bg-card/80 px-4 py-4"
    >
      <p className="text-sm font-medium text-ink">
        O paciente indicou que não entendeu.
      </p>
      <p className="text-sm text-ink-soft">
        Isso não é uma recusa e não altera o que está apresentado. O que fazer a
        seguir é decisão sua.
      </p>
      <div className="flex flex-wrap gap-2">
        <Control onClick={onRepeat} disabled={busy}>
          Repetir sem alterar
        </Control>
        {onSimplify && (
          <Control onClick={onSimplify} disabled={busy}>
            Criar versão simplificada
          </Control>
        )}
        {canGoBack && onBackLevel && (
          <Control onClick={onBackLevel} disabled={busy}>
            Voltar um nível
          </Control>
        )}
        {onCancelContent && (
          <Control onClick={onCancelContent} disabled={busy}>
            Cancelar conteúdo atual
          </Control>
        )}
        <Control onClick={onDismiss} disabled={busy}>
          Fechar
        </Control>
      </div>
      <p className="text-xs text-ink-soft">
        A versão simplificada é escrita por você — o Helo não gera texto.
      </p>
    </section>
  );
}
