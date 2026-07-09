// ——— OverlayPanel: a camada dinâmica de conteúdo da experiência ———
// Painel semi-transparente que aparece SOBRE o palco dos orbes — o orbe
// ativo permanece perceptível acima e através dele (backdrop-blur).

export function OverlayPanel({
  label,
  className = "",
  children,
}: {
  /** Nome da região para leitores de tela. */
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={`fade-rise mx-auto w-full max-w-3xl rounded-3xl border border-line/70 bg-card/75 px-5 py-8 shadow-[var(--shadow-soft)] backdrop-blur-md sm:px-8 ${className}`}
    >
      {children}
    </section>
  );
}
