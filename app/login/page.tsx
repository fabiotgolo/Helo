"use client";

// ——— Entrada da plataforma ———
// Sem sessão válida nenhuma API responde: esta tela é o único caminho.
// Em instalação nova (nenhum usuário), oferece criar o primeiro Admin.

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Orb, TopBar } from "@/components/ui";
import { WelcomeIntro } from "@/components/welcome-orb";
import { MobileHeader } from "@/components/mobile/mobile-header";
import { MobileTabBar } from "@/components/mobile/mobile-tab-bar";
import { usePatient } from "@/lib/patient";

// Destino padrão pós-login: no mobile a experiência abre na Home (sessão
// Conversar, "Toque para falar"); no desktop permanece o Dashboard. Um
// ?next= explícito sempre vence — a autenticação em si não muda.
function defaultDestination(): string {
  return window.matchMedia("(min-width: 640px)").matches ? "/dashboard" : "/";
}

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const { reloadPatients } = usePatient();
  const [mode, setMode] = useState<"loading" | "login" | "bootstrap">("loading");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d: { user: unknown; needsBootstrap: boolean }) => {
        if (d.user) {
          router.replace(search.get("next") || defaultDestination());
        } else {
          setMode(d.needsBootstrap ? "bootstrap" : "login");
        }
      })
      .catch(() => setMode("login"));
  }, [router, search]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const url = mode === "bootstrap" ? "/api/auth/bootstrap" : "/api/auth/login";
      const body =
        mode === "bootstrap" ? { name, email, password } : { email, password };
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await r.json()) as { error?: string };
      if (!r.ok) {
        setError(d.error ?? "não foi possível entrar");
        return;
      }
      // O PatientProvider vive no layout raiz e sobrevive à navegação: a
      // lista dele ainda é a de ANTES do login (vazia, do 401). Recarrega
      // com a sessão nova antes de navegar — o seletor de pacientes e o
      // tema do paciente ativo já chegam prontos no destino.
      await reloadPatients();
      router.replace(search.get("next") || defaultDestination());
    } catch {
      setError("falha de conexão — tente de novo");
    } finally {
      setBusy(false);
    }
  }, [mode, name, email, password, router, search, reloadPatients]);

  return (
    <main className="relative flex w-full flex-1 items-center justify-center px-6 py-10 pb-32 sm:pb-10">
      {/* Primeiro a presença da Helo; o login surge sobre a Orb quando a voz
          termina. O Orb principal (Conversa) fica grande e central, protagonista,
          e nunca desmonta. */}
      <WelcomeIntro
        orbClassName="h-[88vmin] w-[88vmin] max-h-[44rem] max-w-[44rem]"
        className="w-full"
      >
        {(revealed) => (
          <div
            inert={!revealed}
            aria-hidden={!revealed}
            // Painel translúcido do TEMA sobre a Orb: sem ele o texto flutua
            // direto no gradiente coral (claro em todo tema) e perde contraste
            // — no escuro o texto claro some, no claro o título briga com a Orb.
            // Com o painel (bg-cream do tema + blur) o texto sempre contrasta o
            // próprio fundo, e a Orb segue brilhando ao redor.
            className={`flex w-full max-w-xs flex-col gap-6 rounded-[1.75rem] border border-line bg-cream/75 p-6 shadow-soft backdrop-blur-2xl transition-[opacity,transform] duration-700 ease-out sm:max-w-sm sm:p-8 motion-reduce:transition-opacity ${
              revealed
                ? "pointer-events-auto opacity-100 translate-y-0"
                : "pointer-events-none opacity-0 translate-y-2 motion-reduce:translate-y-0"
            }`}
          >
            <div>
              <h1 className="text-3xl font-medium tracking-tight">
                {mode === "bootstrap" ? "Bem-vindo à Helo" : "Entrar"}
              </h1>
              <p className="mt-1 text-ink-soft">
                {mode === "bootstrap"
                  ? "Instalação nova: crie a conta do administrador para começar."
                  : "Acesse com sua conta para acompanhar seus pacientes."}
              </p>
            </div>

            {mode === "loading" ? (
              <p className="py-10 text-center text-ink-soft">Verificando sessão…</p>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
                className="flex flex-col gap-3"
              >
          {mode === "bootstrap" && (
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Seu nome"
              autoComplete="name"
              required
              className="min-h-12 rounded-2xl border border-white/50 bg-card/55 px-5 py-3 outline-none backdrop-blur-md placeholder:text-ink-soft focus:border-ink-mute"
            />
          )}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            autoComplete="email"
            required
            className="min-h-12 rounded-2xl border border-white/50 bg-card/55 px-5 py-3 outline-none backdrop-blur-md placeholder:text-ink-soft focus:border-ink-mute"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "bootstrap" ? "Senha (mínimo 8 caracteres)" : "Senha"}
            autoComplete={mode === "bootstrap" ? "new-password" : "current-password"}
            required
            minLength={mode === "bootstrap" ? 8 : undefined}
            className="min-h-12 rounded-2xl border border-white/50 bg-card/55 px-5 py-3 outline-none backdrop-blur-md placeholder:text-ink-soft focus:border-ink-mute"
          />
          {error && (
            <p role="alert" className="rounded-2xl bg-nao-soft px-4 py-3 text-sm text-nao">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="min-h-12 rounded-full bg-accent px-6 py-3 font-medium text-on-accent hover:bg-accent-strong disabled:opacity-40"
          >
            {busy
              ? "Entrando…"
              : mode === "bootstrap"
                ? "Criar administrador e entrar"
                : "Entrar"}
                </button>
              </form>
            )}
          </div>
        )}
      </WelcomeIntro>

      {/* Mobile: a Home aparece por inteiro antes do acesso — a fila de modos
          é VISUAL (aria-hidden, sem ação própria). Qualquer toque, aqui ou em
          qualquer ponto da tela, conta como primeira interação e revela o
          formulário com fade (comportamento do WelcomeIntro). Nenhuma área
          protegida é alcançável sem sessão. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-28 flex items-start justify-evenly px-4 sm:hidden"
      >
        {(
          [
            ["Rotina", "lilas"],
            ["Emergência", "ambar"],
            ["Atividades", "ceu"],
            ["Helo", "coral"],
          ] as const
        ).map(([label, palette]) => (
          <span key={label} className="flex flex-col items-center gap-1.5">
            {/* breathe: a mesma esfera 3D do palco logado (com fallback em
                gradiente CSS quando não há WebGL). */}
            <Orb palette={palette} breathe className="size-14" />
            <span className="text-[11px] font-medium text-ink-mute">{label}</span>
          </span>
        ))}
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      {/* Desktop mantém a TopBar; o mobile veste o cabeçalho e o menu da Home
          (área de paciente vazia e menu inerte — não há sessão). */}
      <div className="hidden sm:block">
        <TopBar showLogout={false} />
      </div>
      <MobileHeader className="sm:hidden" />
      <MobileTabBar locked className="sm:hidden" />
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
