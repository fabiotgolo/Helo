"use client";

// Sessão do usuário no cliente — espelho leve de /api/auth/me.
// A autorização REAL acontece no servidor; aqui só se decide o que exibir.

import { useCallback, useEffect, useState } from "react";
import type { AppUser } from "@/lib/access-types";
import { stopAllSpeech } from "@/lib/useSpeech";

// Espelhos locais do usuário/paciente (paciente ativo, listas, settings,
// itens de modo). Tudo sob este prefixo é limpo no logout — nada do usuário
// anterior pode sobrar para o próximo login na mesma máquina.
const LOCAL_MIRROR_PREFIX = "helo.";

export function clearLocalMirrors(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(LOCAL_MIRROR_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    /* armazenamento indisponível — o redirecionamento acontece mesmo assim */
  }
}

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
    // 1. Nenhuma voz atravessa o logout: Helo, paciente ou emergência param já.
    stopAllSpeech();
    // 2. Sessões de modo em andamento (conversa, rotina, emergência, mensagem)
    //    tratam beforeunload como "encerre minha sessão com keepalive". O evento
    //    é disparado AQUI, antes de destruir a autenticação, porque o
    //    PATCH /api/sessions exige o cookie ainda válido — depois do passo 3
    //    a chamada viraria 401 e a sessão ficaria órfã.
    window.dispatchEvent(new Event("beforeunload"));
    // 3. Invalida a sessão no servidor e limpa o cookie. Se a rede falhar, a
    //    limpeza local e o redirecionamento acontecem mesmo assim — nada
    //    sensível fica ativo à vista; o token expira no servidor pelo TTL.
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    // 4. Espelhos locais fora: paciente ativo, listas, settings e itens.
    clearLocalMirrors();
    // 5. replace (não href): o login não empilha sobre a tela protegida.
    window.location.replace("/login");
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
