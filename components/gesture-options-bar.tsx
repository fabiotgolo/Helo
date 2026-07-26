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

export function GestureOptionsBar({
  options,
  onSelectOption,
  disabled = false,
  selectedIndex,
  ariaLabel = "Opções de resposta por gesto",
  className = "",
}: {
  options: GestureOption[];
  onSelectOption: (option: GestureOption, index: number) => void;
  disabled?: boolean;
  selectedIndex?: number | null;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`mx-auto flex w-full max-w-4xl flex-row items-stretch justify-center gap-2 sm:gap-3 lg:gap-4 ${className}`}
    >
      {options.map((option, index) => {
        const selected = selectedIndex === index;
        const tone = OPTION_TONES[index % OPTION_TONES.length];
        return (
          <button
            key={`${option.label}-${index}`}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            aria-label={`${option.label}: ${option.sublabel}`}
            onClick={() => onSelectOption(option, index)}
            className={`group flex min-w-0 flex-1 max-w-[160px] cursor-pointer flex-col items-center justify-center rounded-xl border px-3 py-2 text-center transition-all duration-200 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-[180px] sm:px-3.5 sm:py-2.5 lg:max-w-[240px] lg:rounded-2xl lg:px-6 lg:py-4 ${tone} ${
              selected
                ? "ring-2 ring-current ring-offset-2 ring-offset-transparent"
                : ""
            }`}
          >
            <span aria-hidden="true" className="text-xl leading-none lg:text-3xl">{option.emoji}</span>
            <span className="mt-1 text-xs font-semibold uppercase tracking-wide sm:text-sm lg:mt-2 lg:text-base">
              {option.label}
            </span>
            <span className="sr-only">{option.sublabel}</span>
          </button>
        );
      })}
    </div>
  );
}
