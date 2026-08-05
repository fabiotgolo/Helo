"use client";

// ——— Registro do app shell (Fase 4.9.2) ———
//
// Quem registra o Service Worker é a tela da sessão manual, e só ela. Não é
// detalhe de organização: um registro no layout raiz instalaria o Worker para
// todo mundo que abrisse o Helo, inclusive quem nunca usa o modo — e a Fase
// 4.9 pediu explicitamente para não transformar o produto inteiro em PWA.
//
// O ESCOPO, porém, é `/`. Precisa ser: os pedaços do aplicativo vivem em
// `/_next/static/**`, fora de `/conversa/perguntas/`, e um Worker que não
// alcança os próprios pedaços não consegue abrir tela nenhuma sem rede.
// Registrar de uma página funda com escopo raiz é permitido porque o script
// está servido da raiz (`/sw.js`).
//
// A VERSÃO viaja na URL do script. Versão nova ⇒ URL nova ⇒ o navegador
// entende que é outro Worker, instala, e o cache antigo morre na ativação.
// Nenhum passo de build, nenhum arquivo gerado.

import { useCallback, useEffect, useState } from "react";
import { APP_COMMIT, APP_VERSION } from "@/lib/version";

/** A mesma string que vira o nome do cache dentro do Worker. */
export const VERSAO_DO_SHELL = `${APP_VERSION}${APP_COMMIT ? `-${APP_COMMIT}` : ""}`;

const URL_DO_WORKER = `/sw.js?v=${encodeURIComponent(VERSAO_DO_SHELL)}`;

export interface EstadoDoShell {
  /** O navegador oferece Service Worker e estamos em contexto seguro. */
  suportado: boolean;
  /** Há um Worker controlando esta página — a tela abre sem rede. */
  ativo: boolean;
  /**
   * Existe uma versão nova esperando. Ela NÃO assume enquanto houver aba
   * aberta: trocar os pedaços do aplicativo debaixo de uma conversa em
   * andamento é o tipo de coisa que quebra uma sessão à beira do leito.
   */
  atualizacaoPendente: boolean;
}

/**
 * Os pedaços que ESTA página realmente usou.
 *
 * Duas fontes, e a segunda é a que faz funcionar:
 *
 *   1. o DOM — `<script src>` e `<link href>` presentes no documento;
 *   2. a linha do tempo de rede (`performance.getEntriesByType("resource")`),
 *      que registra TUDO o que foi de fato buscado.
 *
 * Só o DOM não basta, e isso custou uma rodada inteira de testes para
 * aparecer: o Next carrega pedaços por importação dinâmica depois da
 * hidratação, e eles nunca chegam a ser uma tag no documento. Com a lista
 * incompleta, o HTML abria sem rede e o JavaScript não — a tela aparecia
 * inerte, com "—" no lugar do assistente e do paciente e o botão desabilitado.
 * Pior do que não abrir: parece que abriu.
 */
function assetsDaPagina(): string[] {
  const urls = new Set<string>([window.location.pathname]);

  const considerar = (bruto: string) => {
    if (!bruto) return;
    try {
      const url = new URL(bruto, window.location.origin);
      if (url.origin !== window.location.origin) return;
      if (!url.pathname.startsWith("/_next/static/")) return;
      urls.add(url.pathname + url.search);
    } catch {
      /* URL inválida — ignora */
    }
  };

  for (const seletor of [
    "script[src]",
    'link[rel="stylesheet"][href]',
    'link[rel="preload"][href]',
    'link[rel="modulepreload"][href]',
  ]) {
    for (const el of document.querySelectorAll(seletor)) {
      considerar(el.getAttribute("src") ?? el.getAttribute("href") ?? "");
    }
  }

  try {
    for (const entrada of performance.getEntriesByType("resource")) {
      considerar(entrada.name);
    }
  } catch {
    /* API indisponível — o DOM já deu a maior parte */
  }

  return [...urls];
}

export function useAppShell(): EstadoDoShell {
  const [suportado, setSuportado] = useState(false);
  const [ativo, setAtivo] = useState(false);
  const [atualizacaoPendente, setAtualizacaoPendente] = useState(false);

  const precarregar = useCallback((registro: ServiceWorkerRegistration) => {
    const alvo = registro.active ?? navigator.serviceWorker.controller;
    if (!alvo) return;
    alvo.postMessage({ tipo: "precarregar-shell", urls: assetsDaPagina() });
  }, []);

  useEffect(() => {
    // ——— Só em produção, e não é preguiça de testar ———
    //
    // Em `next dev` o app shell é, ao mesmo tempo, inútil e caro.
    //
    // Inútil: os pedaços do servidor de desenvolvimento trocam de conteúdo a
    // cada edição, então guardá-los não ajuda ninguém a abrir nada amanhã.
    //
    // Caro: o Next compila rota e pedaço SOB DEMANDA, e a precarga pede
    // dezenas deles de uma vez, logo depois de a página abrir. O servidor
    // passa a compilar duas vezes o mesmo trabalho, e telas que montavam em
    // dois segundos passam a estourar dez. Isso apareceu como falhas
    // itinerantes na suíte de interface — um teste diferente a cada rodada,
    // sempre esperando a tela montar. Não era o produto; era o app shell
    // disputando o compilador com a própria página.
    //
    // Quem exercita o Worker de verdade é `npm run test:ui:shell`, contra um
    // build de produção (veja `helo-prod-shell` em .claude/launch.json).
    if (process.env.NODE_ENV !== "production") return;

    // `serviceWorker` só existe em contexto seguro (https ou localhost). Num
    // acesso por IP da rede local sobre http — como se testa em tablet — ele
    // simplesmente não está lá, e o modo segue funcionando com rede.
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    let cancelado = false;
    const cronometros: ReturnType<typeof setTimeout>[] = [];

    void (async () => {
      try {
        const registro = await navigator.serviceWorker.register(URL_DO_WORKER, {
          scope: "/",
        });
        if (cancelado) return;
        setSuportado(true);

        const marcarEspera = () => {
          if (!cancelado) setAtualizacaoPendente(!!registro.waiting);
        };
        marcarEspera();
        registro.addEventListener("updatefound", () => {
          const novo = registro.installing;
          if (!novo) return;
          novo.addEventListener("statechange", marcarEspera);
        });

        await navigator.serviceWorker.ready;
        if (cancelado) return;
        setAtivo(!!navigator.serviceWorker.controller);

        // Duas passadas, de propósito. A primeira guarda o que já carregou; a
        // segunda alcança os pedaços que o Next busca por importação dinâmica
        // DEPOIS da hidratação, e que na primeira ainda não existiam.
        precarregar(registro);
        const segundaPassada = setTimeout(() => {
          if (!cancelado) precarregar(registro);
        }, 2500);
        cronometros.push(segundaPassada);
      } catch {
        // Registro recusado (contexto inseguro, política do navegador): o modo
        // continua funcionando com rede, e a tela não quebra por isso.
      }
    })();

    const aoTrocarControlador = () => {
      if (!cancelado) setAtivo(!!navigator.serviceWorker.controller);
    };
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      aoTrocarControlador
    );

    return () => {
      cancelado = true;
      for (const t of cronometros) clearTimeout(t);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        aoTrocarControlador
      );
    };
  }, [precarregar]);

  return { suportado, ativo, atualizacaoPendente };
}
