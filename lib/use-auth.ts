"use client";

// Sessão do usuário no cliente — espelho leve de /api/auth/me.
// A autorização REAL acontece no servidor; aqui só se decide o que exibir.

import { useCallback, useEffect, useState } from "react";
import type { AppUser } from "@/lib/access-types";
import { stopAllSpeech } from "@/lib/useSpeech";
import {
  contarPendenciasOffline,
  limparArmazenamentoOffline,
} from "@/lib/offline/limpeza";

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

/**
 * Espelho do usuário autenticado. Mesmo prefixo, mesmo ciclo de vida e mesma
 * limpeza dos demais espelhos `helo.*` — e, como eles, NÃO concede acesso a
 * nada: as rotas continuam exigindo o cookie e reverificando o vínculo com o
 * paciente a cada requisição.
 *
 * Ele existe por causa da Fase 4.9. Sem rede, `/api/auth/me` não responde — e
 * tratar isso como "não autenticado" mandava para o login um cuidador que
 * estava no meio de uma conversa, com tudo guardado neste aparelho e
 * inalcançável. Não conseguir PERGUNTAR quem é o usuário não é o mesmo que o
 * servidor RESPONDER que não há ninguém.
 *
 * Nenhum token entra aqui: o cookie é HttpOnly e continua sendo a única prova
 * de sessão que o servidor aceita.
 */
const USER_MIRROR_KEY = "helo.user";

function lerEspelhoDoUsuario(): AppUser | null {
  try {
    const bruto = localStorage.getItem(USER_MIRROR_KEY);
    return bruto ? (JSON.parse(bruto) as AppUser) : null;
  } catch {
    return null;
  }
}

function gravarEspelhoDoUsuario(user: AppUser | null): void {
  try {
    if (user) localStorage.setItem(USER_MIRROR_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_MIRROR_KEY);
  } catch {
    /* armazenamento indisponível — o app segue com o estado em memória */
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
      // O servidor RESPONDEU: a verdade é dele, inclusive quando a resposta é
      // "não há sessão" — e aí o espelho sai junto.
      setUser(d.user);
      gravarEspelhoDoUsuario(d.user);
    } catch {
      // Não conseguimos falar com o servidor. Isso não é uma negativa: é
      // silêncio. Seguimos com o último usuário conhecido, se houver.
      setUser(lerEspelhoDoUsuario());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const logout = useCallback(async () => {
    // 0. Sair apaga o que este aparelho guardou sem conexão. Se houver
    //    intenção esperando o servidor, o cuidador decide — §8 da Fase 4.9:
    //    nunca apagar operação pendente em silêncio.
    //
    //    `window.confirm` e não o diálogo do produto: este hook vive em toda
    //    página, inclusive nas que não montam `HeloDialogProvider`, e um
    //    logout que dependesse de um provider poderia simplesmente não
    //    perguntar. Aqui ele pergunta sempre.
    const pendentes = await contarPendenciasOffline();
    if (pendentes > 0) {
      const seguir = window.confirm(
        `Há ${pendentes} ${pendentes === 1 ? "registro salvo" : "registros salvos"} neste aparelho que ainda não ${pendentes === 1 ? "foi enviado" : "foram enviados"} ao Helo. Sair agora ${pendentes === 1 ? "o descarta" : "os descarta"}.\n\nDeseja sair mesmo assim?`
      );
      if (!seguir) return;
    }

    // 1. Nenhuma voz atravessa o logout: Helo, paciente ou emergência param já.
    window.dispatchEvent(new Event("helo-agent-stop"));
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
    // 5. E a área sem conexão junto — chave primeiro. Não esperamos por ela:
    //    o redirecionamento não pode ficar refém do banco local, e o que não
    //    apagar agora apaga na abertura seguinte.
    void limparArmazenamentoOffline();
    // 6. replace (não href): o login não empilha sobre a tela protegida.
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
