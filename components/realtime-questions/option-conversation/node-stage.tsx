"use client";

// ——— A superfície que o PACIENTE vê num nível da conversa por opções ———
//
// A REGRA desta tela, e a razão de ela existir separada de question-stage:
//
//   • o emoji e o gesto físico NÃO mudam — são as mesmas três âncoras do
//     paciente, na mesma ordem de sempre;
//   • muda SOMENTE o texto vinculado às posições 1, 2 e 3;
//   • com opções personalizadas, SIM/TALVEZ/NÃO ficam OCULTOS — nem no texto
//     visível, nem no aria-label;
//   • SIM/TALVEZ/NÃO voltam apenas na pergunta fechada e na confirmação da
//     frase final.
//
// Sem isso, "opção 2" e "TALVEZ" ocupariam o mesmo botão e o assistente teria
// de adivinhar qual dos dois significados vale agora.

import { GestureOptionsBar } from "@/components/gesture-options-bar";
import { useSignalAnchors } from "@/components/realtime-questions/question-stage";
import type { OptionConversationOption } from "@/lib/option-conversation-types";
import type { PatientResponseProfile } from "@/lib/realtime-question-types";

export interface OptionChoice {
  optionId: string;
  emoji: string;
  /** O texto da OPÇÃO ("FAMÍLIA") — nunca "SIM". */
  label: string;
  /** O sinal observável do paciente ("Palma aberta"). */
  sublabel: string;
}

/**
 * Posição → âncora física, sempre nesta ordem:
 *   opção 1 → âncora de YES · opção 2 → âncora de MAYBE · opção 3 → âncora de NO
 *
 * É o mesmo gesto de sempre em cada lugar. Um nível com uma ou duas opções usa
 * as âncoras das posições 1 e 2, sem reordenar nada.
 */
export function useOptionChoices(
  profile: PatientResponseProfile | null,
  options: OptionConversationOption[]
): OptionChoice[] {
  const anchors = useSignalAnchors(profile);
  return options
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((option, i) => ({
      optionId: option.id,
      emoji: anchors[i]?.emoji ?? anchors[0].emoji,
      label: option.label,
      sublabel: anchors[i]?.sublabel ?? "",
    }));
}

export function NodeStage({
  prompt,
  choices,
  selectedOptionId,
  awaiting,
  disabled = false,
  onSelect,
}: {
  prompt: string;
  choices: OptionChoice[];
  /** Opção provisória em curso — destacada, nunca confirmada sozinha. */
  selectedOptionId: string | null;
  /**
   * O nível já está de fato aguardando seleção. Enquanto o servidor não
   * confirma esse estado as opções NÃO aparecem: mostrar botões que ainda não
   * registram nada convidaria o assistente a tocar no vazio.
   */
  awaiting: boolean;
  disabled?: boolean;
  onSelect: (optionId: string) => void;
}) {
  const selectedIndex = selectedOptionId
    ? choices.findIndex((c) => c.optionId === selectedOptionId)
    : null;
  return (
    <section
      aria-live="polite"
      className="mx-auto flex w-full flex-col items-center gap-10 sm:gap-12"
    >
      <h1 className="text-balance text-center text-4xl font-medium leading-tight tracking-tight text-ink sm:text-5xl lg:text-6xl">
        {prompt}
      </h1>
      {awaiting ? (
        <GestureOptionsBar
          options={choices.map((c) => ({
            id: c.optionId,
            emoji: c.emoji,
            label: c.label,
            sublabel: c.sublabel,
          }))}
          // As opções têm exatamente o mesmo peso visual: nenhuma cor, tamanho
          // ou posição pode sugerir uma escolha (§4).
          tone="neutro"
          size="apresentacao"
          ariaLabel="Opções apresentadas ao paciente"
          selectedIndex={
            selectedIndex != null && selectedIndex >= 0 ? selectedIndex : null
          }
          disabled={disabled}
          onSelectOption={(option) => onSelect(String(option.id))}
        />
      ) : (
        <p className="text-ink-mute">Apresentando as opções…</p>
      )}
    </section>
  );
}
