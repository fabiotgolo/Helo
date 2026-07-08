import Link from "next/link";
import { Orb, TopBar, PillLink, GestureLegend } from "@/components/ui";

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
        right={
          <>
            <PillLink href="/ajustes">Ajustes</PillLink>
            <PillLink href="/dashboard">Dashboard</PillLink>
            <PillLink href="/conversa" dark>
              Iniciar conversa
            </PillLink>
          </>
        }
      />

      <main className="flex flex-1 flex-col items-center justify-center gap-14 px-6 py-10">
        <div className="text-center">
          <h1 className="text-4xl font-medium tracking-tight sm:text-5xl">
            O elo entre sentir e dizer.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-lg text-ink-soft">
            Comunicação assistiva com respeito, cuidado e consentimento.
            O paciente escolhe — o Helo dá voz.
          </p>
        </div>

        <div className="grid w-full max-w-5xl grid-cols-1 items-end gap-10 sm:grid-cols-3">
          <ModeCard
            href="/rotina"
            palette="lilas"
            orbSize="h-52 w-52"
            title="Rotina"
            description="Frases do dia a dia, prontas para usar. Funciona sem IA."
          />
          <ModeCard
            href="/conversa"
            palette="coral"
            orbSize="h-64 w-64"
            title="Conversar"
            description="Conversa guiada por voz e gestos, no ritmo do paciente."
            featured
          />
          <ModeCard
            href="/emergencia"
            palette="ambar"
            orbSize="h-52 w-52"
            title="Emergência"
            description="Ajuda imediata, sempre disponível. Não depende de IA."
          />
        </div>

        <div className="flex flex-col items-center gap-4">
          <Link
            href="/mensagem"
            className="rounded-full border border-line bg-card px-6 py-3 font-medium transition-colors hover:border-ink-mute"
          >
            ✉️ Montar mensagem — frase por frase, no ritmo do paciente
          </Link>
          <GestureLegend />
          <p className="max-w-lg text-center text-sm text-ink-mute">
            O Helo nunca fala, deduz ou decide pelo paciente. Toda mensagem é
            confirmada antes de ser comunicada, salva ou compartilhada.
          </p>
        </div>
      </main>
    </div>
  );
}

function ModeCard({
  href,
  palette,
  orbSize,
  title,
  description,
  featured = false,
}: {
  href: string;
  palette: "coral" | "lilas" | "ambar";
  orbSize: string;
  title: string;
  description: string;
  featured?: boolean;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col items-center gap-6 rounded-3xl p-4 transition-transform hover:scale-[1.02]"
    >
      <Orb palette={palette} breathe={featured} className={orbSize}>
        {featured && (
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white text-2xl shadow-lg">
            ▶
          </span>
        )}
      </Orb>
      <div className="text-center">
        <h2 className="text-2xl font-medium tracking-tight">
          {title}{" "}
          <span className="inline-block transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5">
            ↗
          </span>
        </h2>
        <p className="mt-2 max-w-60 text-ink-soft">{description}</p>
      </div>
    </Link>
  );
}
