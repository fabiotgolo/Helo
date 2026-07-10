// ——— OverlayPanel: a camada dinâmica de conteúdo da experiência ———
// Painel semi-transparente que aparece SOBRE o palco dos orbes — o orbe
// ativo permanece perceptível acima e através dele (backdrop-blur).

export function OverlayPanel({
  label,
  variant = "padrao",
  className = "",
  children,
}: {
  /** Nome da região para leitores de tela. */
  label: string;
  /**
   * padrao — painel sob a faixa compacta de orbes.
   * imersivo — painel SOBRE o orbe grande: mais translúcido, o suficiente
   * para a animação atravessar sem comprometer a leitura.
   */
  variant?: "padrao" | "imersivo";
  className?: string;
  children: React.ReactNode;
}) {
  const skin =
    variant === "imersivo"
      ? "border-line/50 bg-card/60 backdrop-blur-md"
      : "border-line/70 bg-card/75 backdrop-blur-md";
  return (
    <section
      aria-label={label}
      className={`fade-rise pointer-events-auto mx-auto w-full max-w-3xl rounded-3xl border px-5 py-8 shadow-[var(--shadow-soft)] sm:px-8 ${skin} ${className}`}
    >
      {children}
    </section>
  );
}
