"use client";

export type GestureOption = {
  id?: string;
  emoji: string;
  label: string;
  sublabel: string;
};

const OPTION_TONES = [
  "border-sim/40 bg-sim-soft text-sim hover:border-sim/70 hover:bg-sim-soft/80",
  "border-talvez/40 bg-talvez-soft text-talvez hover:border-talvez/70 hover:bg-talvez-soft/80",
  "border-nao/40 bg-nao-soft text-nao hover:border-nao/70 hover:bg-nao-soft/80",
];

// Superfície idêntica nas três opções. Em "Perguntas em tempo real" nenhuma
// resposta pode parecer mais correta, positiva ou recomendada que outra — a
// cor por índice (verde/âmbar/vermelho) induziria exatamente isso.
const NEUTRAL_TONE =
  "border-line bg-card text-ink hover:border-ink-mute hover:bg-card";

export function GestureOptionsBar({
  options,
  onSelectOption,
  disabled = false,
  selectedIndex,
  ariaLabel = "Opções de resposta por gesto",
  tone = "gestos",
  size = "compacto",
  className = "",
}: {
  options: GestureOption[];
  onSelectOption: (option: GestureOption, index: number) => void;
  disabled?: boolean;
  selectedIndex?: number | null;
  ariaLabel?: string;
  /**
   * gestos — cores semânticas por gesto (comportamento histórico, padrão).
   * neutro — as três opções com exatamente o mesmo peso visual.
   */
  tone?: "gestos" | "neutro";
  /** apresentacao — alvos e tipografia ampliados para a tela do paciente. */
  size?: "compacto" | "apresentacao";
  className?: string;
}) {
  const large = size === "apresentacao";
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`mx-auto flex w-full flex-row items-stretch justify-center ${
        large ? "max-w-5xl gap-3 sm:gap-5" : "max-w-4xl gap-2 sm:gap-3 lg:gap-4"
      } ${className}`}
    >
      {options.map((option, index) => {
        const selected = selectedIndex === index;
        const skin =
          tone === "neutro" ? NEUTRAL_TONE : OPTION_TONES[index % OPTION_TONES.length];
        const box = large
          ? "max-w-[280px] rounded-3xl px-4 py-6 sm:px-6 sm:py-8"
          : "max-w-[160px] rounded-xl px-3 py-2 sm:max-w-[180px] sm:px-3.5 sm:py-2.5 lg:max-w-[240px] lg:rounded-2xl lg:px-6 lg:py-4";
        return (
          <button
            key={`${option.label}-${index}`}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            aria-label={`${option.label}: ${option.sublabel}`}
            onClick={() => onSelectOption(option, index)}
            className={`group relative flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center border text-center transition-all duration-200 active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50 ${box} ${skin} ${
              selected
                ? "ring-2 ring-current ring-offset-2 ring-offset-transparent"
                : ""
            }`}
          >
            {/* A seleção nunca depende só de cor: além do anel, uma marca. */}
            {selected && (
              <span
                aria-hidden="true"
                className={`absolute right-2 top-2 leading-none ${large ? "text-xl" : "text-sm"}`}
              >
                ✓
              </span>
            )}
            <span
              aria-hidden="true"
              className={large ? "text-5xl leading-none sm:text-6xl" : "text-xl leading-none lg:text-3xl"}
            >
              {option.emoji}
            </span>
            <span
              className={`font-semibold uppercase tracking-wide ${
                large
                  ? "mt-3 text-xl sm:text-2xl"
                  : "mt-1 text-xs sm:text-sm lg:mt-2 lg:text-base"
              }`}
            >
              {option.label}
            </span>
            {large ? (
              <span className="mt-1 text-sm font-normal normal-case tracking-normal text-ink-soft">
                {option.sublabel}
              </span>
            ) : (
              <span className="sr-only">{option.sublabel}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
