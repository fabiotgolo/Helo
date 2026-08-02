"use client";

// ——— A superfície que o PACIENTE vê ———
// Só a pergunta e as três respostas. Nada administrativo, nenhum histórico
// ocupando a área principal e nenhuma pista visual que sugira uma resposta:
// as três opções têm exatamente o mesmo peso (tone="neutro").

import { GestureOptionsBar } from "@/components/gesture-options-bar";
import { useGestures } from "@/lib/gestures";
import type { Gesture } from "@/lib/types";
import {
  SEMANTIC_RESPONSE_LABELS,
  SEMANTIC_RESPONSES,
  type PatientResponseProfile,
  type SemanticResponse,
} from "@/lib/realtime-question-types";

export interface AnswerChoice {
  response: SemanticResponse;
  emoji: string;
  label: string;
  /** O sinal observável configurado para este paciente ("palma aberta"). */
  sublabel: string;
}

const GESTURE_KEYS: readonly string[] = ["sim", "talvez", "nao"];

/**
 * Âncora visual de cada resposta semântica. O emoji é a linguagem visual do
 * Helo para SIM/TALVEZ/NÃO e vem sempre da configuração do paciente; quando o
 * sinal mapeado não é um dos três gestos (olhar, piscar, toque — métodos das
 * próximas fases), o emoji do lugar semântico é mantido e é o RÓTULO abaixo
 * que descreve o sinal real observado. Sem isso, uma opção ficaria sem
 * símbolo e perderia o peso visual das outras — exatamente o que a regra dos
 * três pesos iguais proíbe.
 */
const ANCHOR_GESTURE: Record<SemanticResponse, Gesture> = {
  YES: "sim",
  MAYBE: "talvez",
  NO: "nao",
};

/**
 * As TRÊS ÂNCORAS FÍSICAS do paciente, sempre na mesma ordem: o sinal
 * configurado para YES, o de MAYBE e o de NO. É o gesto que ele já faz, com o
 * emoji que ele já reconhece.
 *
 * Isto é deliberadamente independente de SIM/TALVEZ/NÃO: na conversa por
 * opções as mesmas três âncoras recebem os rótulos das opções (FAMÍLIA, SAÚDE,
 * ROTINA) e as palavras semânticas somem. O paciente não reaprende nada — só o
 * TEXTO acima de cada gesto muda.
 */
export interface SignalAnchor {
  emoji: string;
  /** Descrição FÍSICA do sinal ("Palma aberta") — nunca a palavra semântica. */
  sublabel: string;
}

export function useSignalAnchors(
  profile: PatientResponseProfile | null
): SignalAnchor[] {
  const gestures = useGestures();
  return SEMANTIC_RESPONSES.map((response) => {
    const mapping = profile?.mappings.find((m) => m.response === response);
    const key = mapping?.signalKey ?? "";
    const known = GESTURE_KEYS.includes(key) ? (key as Gesture) : null;
    const anchor = known ?? ANCHOR_GESTURE[response];
    return {
      emoji: gestures[anchor].emoji,
      sublabel: mapping?.label ?? gestures[anchor].hint,
    };
  });
}

/**
 * Monta as três opções na ordem SIM · TALVEZ · NÃO a partir do mapeamento do
 * paciente. O emoji vem da configuração de gestos DELE (lib/gestures.tsx) —
 * o que muda aqui é apenas a resposta semântica associada, restrita a este
 * modo. Sem mapeamento gravado, o serviço já devolve o padrão.
 */
export function useAnswerChoices(
  profile: PatientResponseProfile | null
): AnswerChoice[] {
  const anchors = useSignalAnchors(profile);
  return SEMANTIC_RESPONSES.map((response, i) => ({
    response,
    emoji: anchors[i].emoji,
    label: SEMANTIC_RESPONSE_LABELS[response],
    sublabel: anchors[i].sublabel,
  }));
}

export function QuestionStage({
  question,
  choices,
  selected,
  disabled = false,
  awaiting,
  onSelect,
}: {
  question: string;
  choices: AnswerChoice[];
  /** Resposta provisória em curso — destacada, nunca confirmada sozinha. */
  selected: SemanticResponse | null;
  disabled?: boolean;
  /**
   * A pergunta já está de fato aguardando resposta. Enquanto o servidor não
   * confirma esse estado, as opções NÃO aparecem: mostrar três botões que
   * ainda não registram nada convidaria o assistente a tocar no vazio.
   */
  awaiting: boolean;
  onSelect: (response: SemanticResponse) => void;
}) {
  const selectedIndex = selected
    ? choices.findIndex((c) => c.response === selected)
    : null;
  return (
    <section
      aria-live="polite"
      className="mx-auto flex w-full flex-col items-center gap-10 sm:gap-12"
    >
      <h1 className="text-balance text-center text-4xl font-medium leading-tight tracking-tight text-ink sm:text-5xl lg:text-6xl">
        {question}
      </h1>
      {awaiting ? (
        <GestureOptionsBar
          options={choices.map((c) => ({
            id: c.response,
            emoji: c.emoji,
            label: c.label,
            sublabel: c.sublabel,
          }))}
          tone="neutro"
          size="apresentacao"
          ariaLabel="Respostas possíveis do paciente"
          selectedIndex={
            selectedIndex != null && selectedIndex >= 0 ? selectedIndex : null
          }
          disabled={disabled}
          onSelectOption={(option) => onSelect(option.id as SemanticResponse)}
        />
      ) : (
        <p className="text-ink-mute">Apresentando a pergunta…</p>
      )}
    </section>
  );
}
