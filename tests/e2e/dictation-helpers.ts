// ——— Dublês do microfone e do provedor, compartilhados pelas specs de ditado ———
//
// Não existe `getUserMedia` de verdade num Chromium headless com áudio
// previsível, e o que está sendo testado não é a captura: é o que o produto faz
// com o texto que volta. `MediaRecorder` e `mediaDevices` são substituídos por
// dublês, e são a única coisa falsificada — o resto do caminho é o código de
// produção.
//
// Nenhuma chamada real à ElevenLabs: `POST /api/voice/dictation` é interceptado
// na aba inteira. O `GET` do mesmo endereço NÃO é — ele percorre o servidor de
// verdade, com a flag ligada no lote, e é assim que a disponibilidade é provada.
//
// Vivem aqui, e não dentro de uma spec, porque duas specs os usam:
// `voz-ditado` (a camada do navegador, Fase 5.2A/5.2B) e
// `voz-ditado-integrado` (as travessias da Fase 5.2C).

import { expect, type Page } from "@playwright/test";

/**
 * Dublês de microfone. Instalados ANTES de qualquer script da página para que
 * o hook encontre um `MediaRecorder` que existe e um `getUserMedia` que resolve.
 *
 * `__ditado` guarda o que aconteceu com o dispositivo — é por ele que o teste
 * prova que as trilhas foram paradas, que é a única forma de a luz do microfone
 * apagar.
 */
export async function instalarMicrofone(page: Page, opcoes: { permitir?: boolean } = {}) {
  await page.addInitScript((permitir: boolean) => {
    const espiao = {
      streamsAbertos: 0,
      trilhasParadas: 0,
      gravadoresCriados: 0,
      permissaoPedida: 0,
      // Guardado para o teste poder disparar uma callback ATRASADA: o
      // `MediaRecorder` real entrega `ondataavailable`/`onstop` de forma
      // assíncrona, e é justamente essa janela que a emergência precisa
      // atravessar sem deixar um fragmento escapar.
      ultimoGravador: null as null | {
        ondataavailable: ((e: { data: Blob }) => void) | null;
        onstop: (() => void) | null;
      },
    };
    (window as unknown as Record<string, unknown>).__ditado = espiao;

    // O logout termina em `location.replace("/login")`, que destrói a página e,
    // com ela, os contadores. Sem isto, um teste que sai da conta leria um
    // espião recém-nascido e zerado — e concluiria que a trilha não parou
    // justamente quando ela parou. Gravar a cada evento é o que permite ler o
    // placar DEPOIS da navegação.
    const CHAVE = "__ditadoPlacar";
    const gravar = () => {
      try {
        sessionStorage.setItem(
          CHAVE,
          JSON.stringify({
            streamsAbertos: espiao.streamsAbertos,
            trilhasParadas: espiao.trilhasParadas,
            gravadoresCriados: espiao.gravadoresCriados,
            permissaoPedida: espiao.permissaoPedida,
          })
        );
      } catch {
        // sessionStorage indisponível: os contadores em memória ainda valem.
      }
    };
    const anterior = (() => {
      try {
        return JSON.parse(sessionStorage.getItem(CHAVE) ?? "null");
      } catch {
        return null;
      }
    })();
    if (anterior) Object.assign(espiao, anterior);

    class TrilhaFalsa {
      kind = "audio";
      enabled = true;
      readyState = "live";
      onended: (() => void) | null = null;
      stop() {
        if (this.readyState === "ended") return;
        this.readyState = "ended";
        espiao.trilhasParadas += 1;
        gravar();
      }
    }

    class StreamFalso {
      private trilhas = [new TrilhaFalsa()];
      getTracks() {
        return this.trilhas;
      }
      getAudioTracks() {
        return this.trilhas;
      }
    }

    class MediaRecorderFalso {
      static isTypeSupported() {
        return true;
      }
      state = "inactive";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        espiao.gravadoresCriados += 1;
        espiao.ultimoGravador = this;
        gravar();
      }
      start() {
        this.state = "recording";
      }
      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        // Um pedaço de áudio plausível: o produto só precisa de bytes.
        this.ondataavailable?.({ data: new Blob([new Uint8Array(1024)], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }

    (window as unknown as Record<string, unknown>).MediaRecorder = MediaRecorderFalso;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          espiao.permissaoPedida += 1;
          gravar();
          if (!permitir) {
            const erro = new Error("permissão negada");
            erro.name = "NotAllowedError";
            throw erro;
          }
          espiao.streamsAbertos += 1;
          gravar();
          return new StreamFalso();
        },
      },
    });
  }, opcoes.permitir !== false);
}

/** Intercepta só o POST. O GET continua sendo respondido pelo servidor real. */
export async function interceptarTranscricao(
  page: Page,
  responder: (n: number) => { status: number; body: unknown }
) {
  const chamadas: string[] = [];
  await page.route("**/api/voice/dictation", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    chamadas.push(route.request().url());
    const r = responder(chamadas.length);
    await route.fulfill({
      status: r.status,
      contentType: "application/json",
      body: JSON.stringify(r.body),
    });
  });
  return chamadas;
}

/** Faz o servidor declarar o ditado indisponível, sem mexer no ambiente. */
export async function declararIndisponivel(page: Page) {
  await page.route("**/api/voice/dictation", async (route) => {
    if (route.request().method() !== "GET") {
      // Um POST aqui seria justamente o defeito: capturar com o recurso
      // desligado. Deixamos passar para o teste conseguir contá-lo.
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ available: false }),
    });
  });
}

/** O botão de ditar de um campo, pelo rótulo que o produto dá a ele. */
export function botaoDitar(page: Page, rotulo = "a pergunta") {
  return page.getByRole("button", { name: new RegExp(`Ditar ${rotulo} por voz`) });
}

/** Um ciclo completo: abre o microfone, fala, para e espera o texto chegar. */
export async function ditar(page: Page, rotulo = "a pergunta") {
  await botaoDitar(page, rotulo).click();
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toBeVisible();
  await page.getByRole("button", { name: /Parar de ditar/ }).click();
}

/** O que aconteceu com o dispositivo: streams abertos, trilhas paradas, etc. */
export const espiao = (page: Page) =>
  page.evaluate(() => {
    // O placar persistido é o cumulativo da ABA, e não o da página atual —
    // é ele que sobrevive ao `location.replace` do logout.
    try {
      const salvo = JSON.parse(sessionStorage.getItem("__ditadoPlacar") ?? "null");
      if (salvo) return salvo as Record<string, number>;
    } catch {
      /* cai para o de memória */
    }
    return (window as unknown as Record<string, Record<string, number>>).__ditado;
  });
