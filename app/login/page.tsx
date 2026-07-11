"use client";

// ——— Entrada da plataforma ———
// Sem sessão válida nenhuma API responde: esta tela é o único caminho.
// Em instalação nova (nenhum usuário), oferece criar o primeiro Admin.

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TopBar } from "@/components/ui";

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
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
          router.replace(search.get("next") || "/dashboard");
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
      router.replace(search.get("next") || "/dashboard");
    } catch {
      setError("falha de conexão — tente de novo");
    } finally {
      setBusy(false);
    }
  }, [mode, name, email, password, router, search]);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-6 py-10">
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
              className="min-h-12 rounded-2xl border border-line bg-card px-5 py-3 outline-none focus:border-ink-mute"
            />
          )}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            autoComplete="email"
            required
            className="min-h-12 rounded-2xl border border-line bg-card px-5 py-3 outline-none focus:border-ink-mute"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "bootstrap" ? "Senha (mínimo 8 caracteres)" : "Senha"}
            autoComplete={mode === "bootstrap" ? "new-password" : "current-password"}
            required
            minLength={mode === "bootstrap" ? 8 : undefined}
            className="min-h-12 rounded-2xl border border-line bg-card px-5 py-3 outline-none focus:border-ink-mute"
          />
          {error && (
            <p role="alert" className="rounded-2xl bg-nao-soft px-4 py-3 text-sm text-nao">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="min-h-12 rounded-full bg-ink px-6 py-3 font-medium text-white hover:bg-black disabled:opacity-40"
          >
            {busy
              ? "Entrando…"
              : mode === "bootstrap"
                ? "Criar administrador e entrar"
                : "Entrar"}
          </button>
        </form>
      )}
    </main>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar />
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
