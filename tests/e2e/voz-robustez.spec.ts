// ——— Robustez da voz no navegador de verdade (Fase 5.1B) ———
//
//   npm run test:ui:voz
//
// As suítes de domínio (`test:audio:cache`, `test:voice:cancel`) provam os
// módulos em isolamento, e a estrutural (`test:audio:lifecycle`) prova que o
// produto os usa. O que falta é o navegador: `URL.createObjectURL` real,
// desmontagem de árvore React real, logout real.
//
// **A ElevenLabs nunca é chamada.** `/api/tts` é interceptado e responde um
// WAV de silêncio gerado aqui. O que se mede é o COMPORTAMENTO do cliente
// diante das respostas do servidor — e nenhum caractere é sintetizado.
//
// ——— O que esta suíte NÃO afirma ———
//
// Que o áudio soou. O Chromium do Playwright roda com a política de autoplay
// padrão, e uma reprodução sem gesto do usuário pode ser negada — o que o
// produto trata como "bloqueada", não como erro. Afirmar reprodução aqui
// produziria um teste que falha por motivo errado.
//
// O que se afirma é o que independe disso e é justamente onde estavam os
// defeitos: quais requisições saem, quais são abortadas, e se todo ObjectURL
// criado acaba revogado.

import { expect, test, type Page } from "@playwright/test";
import { entrarComo, selecionarPaciente, semear, type Semente } from "./helpers";

/** WAV de 0,2s em silêncio — decodificável, minúsculo, sem custo. */
function wavDeSilencio(): Buffer {
  const taxa = 8000;
  const amostras = Math.floor(taxa * 0.2);
  const dados = Buffer.alloc(amostras * 2); // PCM 16 bits, tudo zero
  const cabecalho = Buffer.alloc(44);
  cabecalho.write("RIFF", 0);
  cabecalho.writeUInt32LE(36 + dados.length, 4);
  cabecalho.write("WAVE", 8);
  cabecalho.write("fmt ", 12);
  cabecalho.writeUInt32LE(16, 16);
  cabecalho.writeUInt16LE(1, 20); // PCM
  cabecalho.writeUInt16LE(1, 22); // mono
  cabecalho.writeUInt32LE(taxa, 24);
  cabecalho.writeUInt32LE(taxa * 2, 28);
  cabecalho.writeUInt16LE(2, 32);
  cabecalho.writeUInt16LE(16, 34);
  cabecalho.write("data", 36);
  cabecalho.writeUInt32LE(dados.length, 40);
  return Buffer.concat([cabecalho, dados]);
}

const AUDIO = wavDeSilencio();

interface Instrumento {
  criados: number;
  revogados: number;
  vivos: number;
}

/**
 * Conta ObjectURLs criados e revogados dentro da página. Precisa entrar ANTES
 * de qualquer script do app — daí o addInitScript.
 */
async function instrumentar(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const estado = { criados: 0, revogados: 0, vivos: new Set<string>() };
    (window as unknown as Record<string, unknown>).__vozInstrumento = estado;
    // O logout termina em `location.replace("/login")`, que destrói a página
    // e, com ela, os contadores. Gravar em sessionStorage a cada evento é o
    // que permite ler o placar DEPOIS da navegação — e o placar do logout é
    // exatamente o que interessa medir.
    const gravar = () => {
      try {
        sessionStorage.setItem(
          "__vozInstrumento",
          JSON.stringify({ criados: estado.criados, revogados: estado.revogados, vivos: estado.vivos.size })
        );
      } catch {
        // sessionStorage indisponível: os contadores em memória ainda valem.
      }
    };
    const criarOriginal = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      const url = criarOriginal(obj);
      estado.criados++;
      estado.vivos.add(url);
      gravar();
      return url;
    };
    const revogarOriginal = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      if (estado.vivos.delete(url)) estado.revogados++;
      gravar();
      revogarOriginal(url);
    };
  });
}

/** Placar atual da página. */
async function lerInstrumento(page: Page): Promise<Instrumento> {
  return page.evaluate(() => {
    const e = (window as unknown as Record<string, { criados: number; revogados: number; vivos: Set<string> }>)
      .__vozInstrumento;
    return { criados: e.criados, revogados: e.revogados, vivos: e.vivos.size };
  });
}

/** Placar que sobreviveu a uma navegação (mesma aba). */
async function lerPlacarPersistido(page: Page): Promise<Instrumento> {
  return page.evaluate(() => {
    const bruto = sessionStorage.getItem("__vozInstrumento");
    return bruto ? (JSON.parse(bruto) as Instrumento) : { criados: 0, revogados: 0, vivos: 0 };
  });
}

/** Controle do /api/tts falso: modo, atraso e contagem. */
interface Provedor {
  modo: "ok" | "indisponivel" | "recusado";
  atrasoMs: number;
  chamadas: number;
  abortadas: number;
}

async function interceptarTts(page: Page, provedor: Provedor): Promise<void> {
  await page.route("**/api/tts", async (route) => {
    provedor.chamadas++;
    if (provedor.atrasoMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, provedor.atrasoMs));
    }
    try {
      if (provedor.modo === "indisponivel") {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "falha na síntese", reason: "timeout" }),
        });
        return;
      }
      if (provedor.modo === "recusado") {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ error: "fala do paciente sem autorização válida" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "audio/wav",
        headers: { "X-Voice-Source": "patientElevenLabsClone" },
        body: AUDIO,
      });
    } catch {
      // A página foi embora (logout, navegação) antes da resposta: é o
      // cancelamento funcionando, não uma falha do teste.
      provedor.abortadas++;
    }
  });
}

let semente: Semente;

test.beforeEach(async ({ page, request }) => {
  semente = await semear(request);
  // A instrumentação e o paciente ativo entram como initScript: os dois
  // precisam existir antes de qualquer script do app rodar.
  await instrumentar(page);
  await selecionarPaciente(page, semente.pacienteId);
  await entrarComo(page, semente.assistente.email);
});

test("a fala do paciente pede grant antes de sintetizar", async ({ page }) => {
  const provedor: Provedor = { modo: "ok", atrasoMs: 0, chamadas: 0, abortadas: 0 };
  await interceptarTts(page, provedor);
  const grants: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/voice/grant")) grants.push(r.url());
  });

  await page.goto("/emergencia");
  await expect(page.getByRole("button", { name: /Preciso de ajuda/i }).first()).toBeVisible();
  // A entrada na tela pré-aquece as frases: cada uma passa pelo grant.
  await expect.poll(() => provedor.chamadas, { timeout: 15_000 }).toBeGreaterThan(0);

  expect(grants.length, "toda síntese de voz do paciente é precedida de um grant").toBeGreaterThan(0);
  expect(
    grants.length,
    "nenhuma chamada de síntese aconteceu sem autorização correspondente"
  ).toBeGreaterThanOrEqual(provedor.chamadas);
});

test("o logout libera todo ObjectURL de áudio", async ({ page }) => {
  const provedor: Provedor = { modo: "ok", atrasoMs: 0, chamadas: 0, abortadas: 0 };
  await interceptarTts(page, provedor);

  await page.goto("/emergencia");
  await expect.poll(() => provedor.chamadas, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect
    .poll(async () => (await lerInstrumento(page)).criados, { timeout: 20_000 })
    .toBeGreaterThan(0);

  const antes = await lerInstrumento(page);
  expect(antes.vivos, "o áudio pré-aquecido fica guardado, como deve ficar").toBeGreaterThan(0);

  // "Sair" está na TopBar do próprio palco — nenhuma navegação intermediária.
  // Isso importa: um `goto` recarregaria o documento e descartaria o heap por
  // conta própria, e o teste passaria sem provar nada sobre a liberação.
  await page.getByRole("button", { name: /^Sair/i }).first().click();
  await page.waitForURL(/\/login/, { timeout: 20_000 });

  // O placar sobreviveu à navegação por sessionStorage. Se a liberação
  // dependesse do heap ser descartado pela troca de página, `vivos` teria
  // ficado onde estava — e era exatamente esse o defeito.
  const depois = await lerPlacarPersistido(page);
  expect(depois.criados, "os mesmos URLs criados antes").toBeGreaterThanOrEqual(antes.criados);
  expect(
    depois.revogados,
    "todo URL criado foi revogado ao sair"
  ).toBe(depois.criados);
  expect(depois.vivos, "nenhum Blob de voz sobrevive ao logout").toBe(0);
});

test("trocar de paciente libera o áudio do anterior", async ({ page, request }) => {
  // A semente vincula Claudia a um único paciente. Para TROCAR é preciso ter
  // dois — o vínculo extra é criado aqui, não na semente, para não mudar o
  // cenário das demais suítes.
  const vinculo = await request.post("/api/admin/access", {
    data: {
      userId: semente.assistente.id,
      patientId: semente.outroPacienteId,
      permissions: ["viewDashboard", "viewSessions", "viewMetrics", "createSession", "editGestures"],
    },
  });
  expect(vinculo.ok(), "vincular o segundo paciente").toBeTruthy();

  const provedor: Provedor = { modo: "ok", atrasoMs: 0, chamadas: 0, abortadas: 0 };
  await interceptarTts(page, provedor);

  await page.goto("/emergencia");
  await expect
    .poll(async () => (await lerInstrumento(page)).vivos, { timeout: 20_000 })
    .toBeGreaterThan(0);
  const antes = await lerInstrumento(page);

  // O seletor de pacientes vive na TopBar do palco: a troca acontece SEM sair
  // da árvore React e sem recarregar o documento. É a única forma de medir a
  // liberação de verdade — uma navegação descartaria o heap sozinha.
  await page.getByRole("button", { name: "Selecionar paciente" }).click();
  await page.getByRole("menuitemradio", { name: /Roberto/i }).click();

  await expect
    .poll(async () => (await lerInstrumento(page)).revogados, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(antes.vivos);
  const depois = await lerInstrumento(page);
  expect(
    depois.criados - depois.revogados,
    "o áudio da voz clonada do paciente anterior não fica na memória da aba"
  ).toBeLessThanOrEqual(depois.criados - antes.vivos);
});

test("503 não desliga a voz para sempre — a tentativa seguinte passa", async ({ page }) => {
  const provedor: Provedor = { modo: "indisponivel", atrasoMs: 0, chamadas: 0, abortadas: 0 };
  await interceptarTts(page, provedor);

  await page.goto("/emergencia");
  await expect.poll(() => provedor.chamadas, { timeout: 15_000 }).toBeGreaterThan(0);
  const durantePrazo = provedor.chamadas;

  // Dentro do prazo, o cliente NÃO insiste: é o que impede a rajada contra um
  // provedor já em dificuldade.
  await page.getByRole("button", { name: /Preciso de ajuda/i }).first().click();
  await page.waitForTimeout(1500);
  expect(
    provedor.chamadas,
    "durante o prazo de espera, nenhuma síntese nova é tentada"
  ).toBe(durantePrazo);

  // O prazo é de 30s no produto. Em vez de esperar, o teste avança o relógio
  // do cliente — o estado é decidido por Date.now().
  provedor.modo = "ok";
  await page.evaluate(() => {
    const agora = Date.now;
    const salto = 60_000;
    Date.now = () => agora.call(Date) + salto;
  });
  await page.getByRole("button", { name: /Preciso de ajuda/i }).first().click();
  await expect
    .poll(() => provedor.chamadas, { timeout: 15_000 })
    .toBeGreaterThan(durantePrazo);
});

test("a indisponibilidade não aparece como mensagem técnica ao paciente", async ({ page }) => {
  const provedor: Provedor = { modo: "indisponivel", atrasoMs: 0, chamadas: 0, abortadas: 0 };
  await interceptarTts(page, provedor);

  await page.goto("/emergencia");
  await expect(page.getByRole("button", { name: /Preciso de ajuda/i }).first()).toBeVisible();
  await page.getByRole("button", { name: /Preciso de ajuda/i }).first().click();
  await page.waitForTimeout(1500);

  const texto = (await page.locator("body").innerText()).toLowerCase();
  for (const vazamento of [
    "503",
    "502",
    "elevenlabs",
    "timeout",
    "objecturl",
    "speechgrant",
    "grant",
    "fetch",
    "undefined",
    "[object",
  ]) {
    expect(texto, `a superfície do paciente não mostra "${vazamento}"`).not.toContain(vazamento);
  }
});

test("o botão de socorro continua utilizável depois de uma falha", async ({ page }) => {
  const provedor: Provedor = { modo: "indisponivel", atrasoMs: 0, chamadas: 0, abortadas: 0 };
  await interceptarTts(page, provedor);

  await page.goto("/emergencia");
  const botao = page.getByRole("button", { name: /Preciso de ajuda/i }).first();
  await expect(botao).toBeVisible();

  // Três toques com o provedor fora do ar: a interface não pode travar nem
  // desabilitar o socorro. A ação da tela existe independentemente da voz.
  for (let i = 0; i < 3; i++) {
    await botao.click();
    await page.waitForTimeout(400);
  }
  await expect(botao, "o botão de socorro segue clicável depois de falhar").toBeEnabled();

  provedor.modo = "ok";
  await botao.click();
  await expect(botao).toBeEnabled();
});

test("salvar uma frase favorita não pede voz do paciente nem mostra erro", async ({ page, request }) => {
  // A tela tinha um "🔊 Ouvir" que mandava o texto SENDO DIGITADO para
  // /api/tts na voz do paciente. Desde a 5.1A o servidor recusa — com razão,
  // rascunho não é fala autorizada de ninguém — e o cuidador levava um alerta
  // vermelho com a mensagem crua do servidor por uma operação que nunca mais
  // ia funcionar.
  //
  // O botão saiu. Este teste prova as duas metades: salvar continua
  // funcionando, e nenhuma síntese é sequer tentada.
  const acesso = await request.post("/api/admin/access", {
    data: {
      userId: semente.assistente.id,
      patientId: semente.pacienteId,
      permissions: [
        "viewDashboard", "viewSessions", "viewMetrics", "createSession", "editGestures",
        "viewActivities", "createActivities", "editActivities",
      ],
    },
  });
  expect(acesso.ok(), "conceder as permissões de Atividades").toBeTruthy();

  const provedor: Provedor = { modo: "ok", atrasoMs: 0, chamadas: 0, abortadas: 0 };
  await interceptarTts(page, provedor);
  const grants: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/voice/grant")) grants.push(r.url());
  });

  await page.goto("/atividades/gerenciar");
  const campo = page.getByPlaceholder(/A Vida me Interessa/i);
  await expect(campo).toBeVisible();

  // Nenhum "Ouvir" ao lado do campo de rascunho.
  await expect(
    page.getByRole("button", { name: /Ouvir/i }),
    "não há botão de prévia do rascunho"
  ).toHaveCount(0);

  await campo.fill("Quero ver o mar hoje.");
  await page.getByRole("button", { name: /Salvar Frase/i }).click();

  // A frase aparece na lista de salvas — o caminho principal segue inteiro.
  await expect(
    page.getByText("Quero ver o mar hoje.", { exact: false }),
    "a frase salva aparece na lista"
  ).toBeVisible({ timeout: 20_000 });

  // Nenhuma tentativa inválida saiu, logo nenhum 403 pôde acontecer.
  expect(provedor.chamadas, "nenhuma síntese foi pedida ao salvar").toBe(0);
  expect(grants.length, "nenhum grant foi pedido para rascunho").toBe(0);

  // E nada técnico na tela.
  //
  // A asserção é sobre o CONTEÚDO, não sobre a ausência de qualquer alerta.
  // Neste ambiente `/synthesizePhraseAudio` é uma Cloud Function que não está
  // no ar, então a tela mostra "A frase foi salva, mas o áudio será preparado
  // novamente ao abrir a atividade" — uma frase em português claro, sobre
  // outro assunto, e pré-existente. Exigir zero alertas transformaria essa
  // condição de ambiente numa falha de teste.
  const corpo = (await page.locator("body").innerText()).toLowerCase();
  for (const vazamento of ["403", "autorização válida", "speechgrant", "confirmationstatus", "grant"]) {
    expect(corpo, `a tela não mostra "${vazamento}"`).not.toContain(vazamento);
  }
});

test("editar uma frase salva também não pede voz do paciente", async ({ page, request }) => {
  await request.post("/api/admin/access", {
    data: {
      userId: semente.assistente.id,
      patientId: semente.pacienteId,
      permissions: [
        "viewDashboard", "viewSessions", "viewMetrics", "createSession", "editGestures",
        "viewActivities", "createActivities", "editActivities",
      ],
    },
  });
  const provedor: Provedor = { modo: "ok", atrasoMs: 0, chamadas: 0, abortadas: 0 };
  await interceptarTts(page, provedor);

  await page.goto("/atividades/gerenciar");
  const campo = page.getByPlaceholder(/A Vida me Interessa/i);
  await expect(campo).toBeVisible();
  await campo.fill("Quero ouvir música.");
  await page.getByRole("button", { name: /Salvar Frase/i }).click();
  await expect(page.getByText("Quero ouvir música.", { exact: false })).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: /^Editar$/ }).first().click();
  // Em edição, o texto no campo também é rascunho — e também não tem "Ouvir".
  await expect(
    page.getByRole("button", { name: /Ouvir/i }),
    "a edição não oferece prévia do texto em digitação"
  ).toHaveCount(0);

  // O campo de edição é o input que carrega o texto atual da frase.
  const emEdicao = page.getByRole("textbox").filter({ hasNot: campo }).last();
  await emEdicao.fill("Quero ouvir música clássica.");

  // A confirmação da edição é a resposta do PATCH, e não a lista atualizada:
  // `saveEditedPhrase` só recarrega a lista DEPOIS de chamar
  // `/synthesizePhraseAudio`, que é uma Cloud Function fora do ar neste
  // ambiente. Esperar pela lista seria testar o emulador de Functions, não o
  // que esta suíte existe para provar.
  const patch = page.waitForResponse(
    (r) => r.url().includes("/api/favorite-phrases") && r.request().method() === "PATCH"
  );
  await page.getByRole("button", { name: /^Salvar$/ }).first().click();
  const resposta = await patch;
  expect(resposta.ok(), "a edição é gravada").toBeTruthy();

  expect(provedor.chamadas, "editar não pede síntese de rascunho").toBe(0);
  const corpo = (await page.locator("body").innerText()).toLowerCase();
  for (const vazamento of ["403", "autorização válida", "speechgrant", "grant"]) {
    expect(corpo, `a tela não mostra "${vazamento}"`).not.toContain(vazamento);
  }
});

test("uma fala nova aborta a síntese da anterior", async ({ page }) => {
  // 6s de atraso: a primeira síntese continua no ar quando a segunda começa.
  // É a situação real da Rotina — o cuidador toca uma resposta e logo a
  // seguinte, e a primeira não pode chegar tocando por cima.
  const provedor: Provedor = { modo: "ok", atrasoMs: 6000, chamadas: 0, abortadas: 0 };
  await interceptarTts(page, provedor);
  const abortadas: string[] = [];
  page.on("requestfailed", (r) => {
    if (r.url().includes("/api/tts")) abortadas.push(r.url());
  });

  await page.goto("/emergencia");
  const botoes = page.getByRole("button", { name: /Preciso de ajuda|Falta de ar|Dor forte/i });
  await expect(botoes.first()).toBeVisible();

  // Duas falas em sequência, com a primeira ainda sendo sintetizada.
  await botoes.nth(0).click();
  await page.waitForTimeout(600);
  await botoes.nth(1).click();

  await expect
    .poll(() => abortadas.length, { timeout: 20_000 })
    .toBeGreaterThan(0);
  expect(
    abortadas.length,
    "a síntese da fala interrompida é derrubada, não apenas ignorada"
  ).toBeGreaterThan(0);
});
