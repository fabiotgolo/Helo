"use client";

// Sessão do usuário no cliente — espelho leve de /api/auth/me.
// A autorização REAL acontece no servidor; aqui só se decide o que exibir.

import { useCallback, useEffect, useState } from "react";
import type { AppUser } from "@/lib/access-types";

export function useAuthUser(): {
  user: AppUser | null;
  loading: boolean;
  reload: () => Promise<void>;
  logout: () => Promise<void>;
} {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/me");
      const d = (await r.json()) as { user: AppUser | null };
      setUser(d.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  }, []);

  return { user, loading, reload, logout };
}

/** Redireciona para /login preservando a página de origem. */
export function redirectToLogin(): void {
  if (window.location.pathname === "/login") return;
  const next = encodeURIComponent(
    window.location.pathname + window.location.search
  );
  window.location.href = `/login?next=${next}`;
}
