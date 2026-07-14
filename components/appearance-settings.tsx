"use client";

// ——— Aparência: painel de escolha de tema visual (Ajustes) ———
// A preferência pertence ao USUÁRIO logado, nunca ao paciente. Selecionar
// aplica na hora (sem reload), mostra o estado selecionado e persiste.
// Cada tema tem também um slider de tamanho de fonte: arrastar aumenta a
// fonte daquele tema (o "Aa" da prévia acompanha; se o tema estiver em uso,
// a interface inteira acompanha na hora).
// Semântica de radiogroup: operável por teclado e leitores de tela.

import {
  useTheme,
  FONT_SCALE_MIN,
  FONT_SCALE_MAX,
  type ThemeMeta,
} from "@/lib/theme";

function ThemePreview({ meta, scale }: { meta: ThemeMeta; scale: number }) {
  const s = meta.swatches;
  return (
    <div
      aria-hidden="true"
      className="flex h-16 items-stretch gap-2 rounded-xl border p-2"
      style={{ background: s.bg, borderColor: "rgba(128,128,128,0.25)" }}
    >
      {/* Mini "card" com amostra de texto primário e secundário — o "Aa"
          cresce junto com o slider de fonte do tema. */}
      <div
        className="flex flex-1 flex-col justify-center gap-1 rounded-lg px-2.5"
        style={{ background: s.surface }}
      >
        <span
          className="font-semibold leading-none"
          style={{ color: s.text, fontSize: `${Math.round(14 * scale)}px` }}
        >
          Aa
        </span>
        <span className="h-1.5 w-10 rounded-full" style={{ background: s.textSoft }} />
      </div>
      {/* Amostra da cor de destaque */}
      <div className="w-6 shrink-0 rounded-lg" style={{ background: s.accent }} />
    </div>
  );
}

export function AppearanceSettings() {
  const { theme, setTheme, themes, fontScales, setFontScale } = useTheme();

  return (
    <section
      aria-labelledby="aparencia-title"
      className="rounded-3xl border border-line bg-card p-6"
    >
      <h2 id="aparencia-title" className="font-semibold tracking-tight">
        Aparência
      </h2>
      <p className="text-sm text-ink-soft">
        O tema de cores é a sua preferência pessoal — vale só para você e não
        altera os dados nem a experiência do paciente. A mudança é imediata.
        Em cada tema, arraste o controle para aumentar o tamanho da fonte.
      </p>

      <div
        role="radiogroup"
        aria-label="Tema de cores"
        className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        {themes.map((meta) => {
          const selected = theme === meta.id;
          const scale = fontScales[meta.id] ?? FONT_SCALE_MIN;
          return (
            <div
              key={meta.id}
              className={`flex flex-col gap-2.5 rounded-2xl border p-3 transition-colors ${
                selected
                  ? "border-accent ring-2 ring-accent"
                  : "border-line hover:border-ink-mute"
              }`}
            >
              {/* O botão-rádio cobre prévia + nome; o slider fica fora dele
                  (controle interativo não pode viver dentro de <button>). */}
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`Tema ${meta.label}. ${meta.description}`}
                onClick={() => setTheme(meta.id)}
                className="flex flex-col gap-2.5 rounded-xl text-left"
              >
                <ThemePreview meta={meta} scale={scale} />
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium leading-tight">{meta.label}</p>
                    <p className="mt-0.5 text-xs text-ink-soft">{meta.description}</p>
                  </div>
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-xs ${
                      selected
                        ? "border-accent bg-accent text-on-accent"
                        : "border-line text-transparent"
                    }`}
                  >
                    ✓
                  </span>
                </div>
              </button>

              {/* Tamanho da fonte deste tema: aplica na hora e persiste. */}
              <label className="flex min-h-8 items-center gap-2">
                <span aria-hidden="true" className="text-xs font-semibold text-ink-soft">
                  A
                </span>
                <input
                  type="range"
                  min={FONT_SCALE_MIN * 100}
                  max={FONT_SCALE_MAX * 100}
                  step={5}
                  value={Math.round(scale * 100)}
                  onChange={(e) => setFontScale(meta.id, Number(e.target.value) / 100)}
                  aria-label={`Tamanho da fonte do tema ${meta.label}`}
                  aria-valuetext={`${Math.round(scale * 100)}%`}
                  className="h-6 w-full accent-accent"
                />
                <span aria-hidden="true" className="text-lg font-semibold leading-none text-ink-soft">
                  A
                </span>
                <span className="w-11 shrink-0 text-right text-xs tabular-nums text-ink-soft">
                  {Math.round(scale * 100)}%
                </span>
              </label>
            </div>
          );
        })}
      </div>
    </section>
  );
}
