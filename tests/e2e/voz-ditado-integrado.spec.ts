// ——— As travessias do ditado (Fase 5.2C) ———
//
// A 5.2A provou o ditado num campo. A 5.2B provou a arbitragem do microfone.
// Esta spec prova o que só aparece quando o ditado ATRAVESSA outra coisa —
// e cada teste aqui existe porque a auditoria da 5.2C apontou uma lacuna que
// nenhuma suíte de domínio alcança:
//
//   §9  "sim", "talvez" e "não" ditados, num fluxo de verdade, continuam texto;
//   §8  os outros dois campos do cuidador — o título do nível e a frase — se
//       comportam como o primeiro: rascunho, revisão, e ação manual;
//   §13 trocar de PACIENTE com uma transcrição em voo: a resposta é descartada;
//   §15 sair da conta durante a captura ou a transcrição não deixa nada atrás;
//   §20 depois de ditar, nenhum armazenamento do navegador guarda áudio.
//
// Roda sobre BUILD, e não sobre o dev server: as jornadas da conversa por
// opções descem níveis e voltam, e a 5.2B mediu que o compilador sob demanda
// é o que estourava o orçamento delas. Uma consequência disso: o objeto de
// inspeção `__heloAudio` NÃO existe aqui (é dev-only, por desenho). Nenhum
// teste desta spec depende dele — o que se observa é o produto pela tela.
//
// Nenhuma chamada real à ElevenLabs: o POST é interceptado na aba.

import { expect, test, type Page } from "@playwright/test";
import {
  abrirModo,
  entrarComo,
  iniciarNovaSessao,
  pularContexto,
  semear,
  type Semente,
} from "./helpers";
import {
  botaoDitar,
  ditar,
  espiao,
  instalarMicrofone,
  interceptarTranscricao,
} from "./dictation-helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  // Claudia nasce ligada a um paciente só. Para provar a troca (§13) ela
  // precisa de dois — o vínculo extra é criado aqui, e não na semeadura
  // compartilhada, para não mudar o mundo de nenhuma outra spec.
  const r = await request.post("/api/admin/access", {
    data: {
      userId: dados.assistente.id,
      patientId: dados.outroPacienteId,
      permissions: [
        "viewDashboard",
        "viewSessions",
        "viewMetrics",
        "createSession",
        "editGestures",
      ],
    },
  });
  expect(r.ok(), "vincular Claudia ao segundo paciente").toBeTruthy();

  await instalarMicrofone(page);
  await entrarComo(page, dados.assistente.email);
});

async function sessaoAberta(page: Page, patientId = dados.pacienteId) {
  await abrirModo(page, patientId);
  await iniciarNovaSessao(page);
  await pularContexto(page);
  await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();
}

const campoPergunta = (page: Page) => page.getByLabel("Pergunta para o paciente");

// ════════════════════════════════════════════════════════════════════════
// §9 · "sim", "talvez" e "não" ditados são palavras, e só
// ════════════════════════════════════════════════════════════════════════
//
// A prova de domínio já existe (scripts/test-dictation-authorship.mjs). O que
// falta é vê-la acontecer numa tela: o cuidador dita exatamente a palavra que
// o paciente usaria para responder, e nada no produto a interpreta.

for (const palavra of ["sim", "talvez", "não"]) {
  test(`"${palavra}" ditado vira texto no campo, e nunca resposta do paciente`, async ({
    page,
  }) => {
    await interceptarTranscricao(page, () => ({
      status: 200,
      body: { transcript: palavra },
    }));
    await sessaoAberta(page);
    await ditar(page);

    // É texto. Está no campo do cuidador, e é editável como qualquer outro.
    await expect(campoPergunta(page)).toHaveValue(palavra);

    // E não é mais nada. A tela é a mesma de antes de ditar: ninguém
    // apresentou, ninguém confirmou, nenhum gesto foi registrado.
    await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();
    await expect(page.getByText("Revisar antes de apresentar")).toHaveCount(0);
    await expect(page.getByText(/Resposta do paciente/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^SIM:/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^TALVEZ:/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^NÃO:/ })).toHaveCount(0);

    // O cuidador segue dono do campo: apagar a palavra é trivial.
    await campoPergunta(page).fill("");
    await expect(campoPergunta(page)).toHaveValue("");
  });
}

// ════════════════════════════════════════════════════════════════════════
// §8 · Os outros dois campos do cuidador
// ════════════════════════════════════════════════════════════════════════

test("o título do nível é ditado como rascunho, e nenhuma opção se escolhe sozinha", async ({
  page,
}) => {
  await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "Sobre qual assunto deseja conversar?" },
  }));
  await sessaoAberta(page);
  await page.getByRole("button", { name: "Conversa por opções" }).click();
  await expect(page.getByRole("heading", { name: /Criar o primeiro nível/ })).toBeVisible();

  const titulo = page.getByLabel("Título ou pergunta do nível");
  await ditar(page, "o título do nível");
  await expect(titulo).toHaveValue("Sobre qual assunto deseja conversar?");

  // Rascunho, não decisão: o editor continua aberto e nada foi apresentado.
  await expect(page.getByRole("heading", { name: /Criar o primeiro nível/ })).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Opções apresentadas ao paciente" })
  ).toHaveCount(0);

  // E é revisável, como qualquer texto digitado.
  await titulo.fill("Sobre qual assunto deseja conversar hoje?");
  await expect(titulo).toHaveValue("Sobre qual assunto deseja conversar hoje?");
});

test("a frase apresentada é ditada como rascunho, e não se confirma sozinha", async ({
  page,
}) => {
  await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "Estou sentindo dor na perna." },
  }));
  await sessaoAberta(page);
  await page.getByRole("button", { name: "Conversa por opções" }).click();
  await expect(page.getByRole("heading", { name: /Criar o primeiro nível/ })).toBeVisible();

  // Um nível só, com uma opção terminal: é o caminho mais curto até o
  // compositor da mensagem em construção.
  await page.getByLabel("Título ou pergunta do nível").fill("Como o senhor está?");
  await page.getByRole("button", { name: "+ Adicionar opção" }).click();
  await page.getByLabel(/^Opção 1/).fill("DOR");
  await page.getByLabel(/^Opção 2/).fill("BEM");
  await page
    .getByRole("checkbox", { name: /Esta opção encerra o caminho/ })
    .nth(0)
    .check();
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText("Revisar antes de apresentar")).toBeVisible();
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await page.getByRole("button", { name: /^DOR:/ }).click();
  await expect(page.getByText("Opção observada: DOR")).toBeVisible();
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();

  const frase = page.getByLabel(/Frase que será apresentada/);
  await expect(frase).toBeVisible();
  await ditar(page, "a frase");
  await expect(frase).toHaveValue("Estou sentindo dor na perna.");

  // Segue "em construção": ditar não apresentou a frase ao paciente, e não
  // existe resposta assumida.
  await expect(page.getByText("Mensagem em construção", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Respostas possíveis do paciente sobre esta frase" })
  ).toHaveCount(0);

  await frase.fill("Estou sentindo dor na perna direita.");
  await expect(frase).toHaveValue("Estou sentindo dor na perna direita.");
});

// ════════════════════════════════════════════════════════════════════════
// §13 · Trocar de paciente com uma transcrição em voo
// ════════════════════════════════════════════════════════════════════════
//
// O teste crítico de isolamento. O provedor demora; no meio da espera o
// cuidador troca de paciente. A resposta chega depois, para um paciente que
// não está mais na tela — e não pode aparecer em lugar nenhum.

test("trocar de paciente durante a transcrição descarta a resposta atrasada", async ({
  page,
}) => {
  let liberar: () => void = () => {};
  const presa = new Promise<void>((r) => {
    liberar = r;
  });
  await page.route("**/api/voice/dictation", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await presa;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ transcript: "texto do paciente anterior" }),
    });
  });

  await sessaoAberta(page);
  await botaoDitar(page).click();
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toBeVisible();
  await page.getByRole("button", { name: /Parar de ditar/ }).click();

  // Troca de paciente com o POST ainda pendurado.
  await page.getByRole("button", { name: "Selecionar paciente" }).click();
  await page.getByRole("menuitemradio", { name: /Sr. Roberto/ }).click();

  liberar();

  // O texto do paciente anterior não aparece em lugar nenhum desta aba.
  await expect(page.getByText("texto do paciente anterior")).toHaveCount(0);
  const campo = campoPergunta(page);
  if (await campo.count()) {
    await expect(campo).not.toHaveValue("texto do paciente anterior");
  }

  // E o microfone foi devolvido: as trilhas do stream antigo estão paradas.
  const visto = await espiao(page);
  expect(visto.trilhasParadas).toBeGreaterThan(0);
});

// ════════════════════════════════════════════════════════════════════════
// §15 · Sair da conta no meio do caminho
// ════════════════════════════════════════════════════════════════════════

test("sair da conta durante a transcrição não deixa transcript, nem trilha aberta", async ({
  page,
}) => {
  let liberar: () => void = () => {};
  const presa = new Promise<void>((r) => {
    liberar = r;
  });
  await page.route("**/api/voice/dictation", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await presa;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ transcript: "não deveria chegar a lugar nenhum" }),
    });
  });

  await sessaoAberta(page);
  await botaoDitar(page).click();
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toBeVisible();
  await page.getByRole("button", { name: /Parar de ditar/ }).click();

  await page.getByRole("button", { name: /^Sair/ }).click();
  // O logout termina em `location.replace("/login")`: esperar a URL é o sinal
  // honesto de que a sessão acabou, sem depender do rótulo do formulário.
  await page.waitForURL("**/login");

  liberar();
  await expect(page.getByText("não deveria chegar a lugar nenhum")).toHaveCount(0);

  const visto = await espiao(page);
  expect(visto.trilhasParadas).toBeGreaterThan(0);

  // Depois de entrar de novo, o estado começa limpo: campo vazio, sem
  // gravação em curso, sem texto herdado da sessão anterior.
  await entrarComo(page, dados.assistente.email);
  await sessaoAberta(page);
  await expect(campoPergunta(page)).toHaveValue("");
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toHaveCount(0);
});

test("sair da conta durante a captura para o microfone e não envia áudio", async ({
  page,
}) => {
  const chamadas = await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "x" },
  }));

  await sessaoAberta(page);
  await botaoDitar(page).click();
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toBeVisible();

  await page.getByRole("button", { name: /^Sair/ }).click();
  // O logout termina em `location.replace("/login")`: esperar a URL é o sinal
  // honesto de que a sessão acabou, sem depender do rótulo do formulário.
  await page.waitForURL("**/login");

  // Capturando, e não transcrevendo: o áudio parcial é descartado, não enviado.
  expect(chamadas).toHaveLength(0);
  const visto = await espiao(page);
  expect(visto.trilhasParadas).toBeGreaterThan(0);
});

// ════════════════════════════════════════════════════════════════════════
// §20 · Depois de ditar, nenhum armazenamento guarda áudio
// ════════════════════════════════════════════════════════════════════════
//
// A regra de domínio ("áudio nunca entra na fila offline") já está provada em
// scripts/test-dictation-authorship.mjs. O que falta é abrir os armazenamentos
// de verdade, num navegador de verdade, depois de um ditado de verdade.
//
// O que se prova é o que o produto GUARDA por decisão — não coleta de lixo do
// JavaScript, que não é assunto de teste.

test("o que fica guardado depois de ditar é texto, e nada mais", async ({ page }) => {
  await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "O senhor está sentindo dor?" },
  }));
  await sessaoAberta(page);
  await ditar(page);
  await expect(campoPergunta(page)).toHaveValue("O senhor está sentindo dor?");

  const achados = await page.evaluate(async () => {
    const suspeito = (v: string) =>
      /^data:audio|^blob:|audio\/webm|audio\/ogg|audio\/mp4|MediaRecorder|LISTENING|DICTATION_/.test(
        v
      );
    const relatorio: { onde: string; chave: string }[] = [];

    for (const [nome, loja] of [
      ["localStorage", localStorage],
      ["sessionStorage", sessionStorage],
    ] as const) {
      for (let i = 0; i < loja.length; i += 1) {
        const chave = loja.key(i)!;
        // Contadores do próprio teste, gravados pelo dublê do microfone para
        // sobreviverem ao logout. São números, não produto — e não podem
        // contar como resíduo do produto.
        if (chave === "__ditadoPlacar") continue;
        const valor = loja.getItem(chave) ?? "";
        if (suspeito(chave) || suspeito(valor)) relatorio.push({ onde: nome, chave });
      }
    }

    // Cache API: o app shell guarda páginas e pedaços, nunca áudio.
    if (typeof caches !== "undefined") {
      for (const nome of await caches.keys()) {
        const c = await caches.open(nome);
        for (const req of await c.keys()) {
          if (/\/api\/voice\/dictation/.test(req.url)) {
            relatorio.push({ onde: `cache:${nome}`, chave: req.url });
          }
        }
      }
    }

    // IndexedDB: é onde a Fase 4.9 guarda rascunho e fila. Varremos tudo.
    const bancos = (await indexedDB.databases?.()) ?? [];
    for (const { name } of bancos) {
      if (!name) continue;
      const db = await new Promise<IDBDatabase>((ok, falha) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => ok(req.result);
        req.onerror = () => falha(req.error);
      });
      for (const store of Array.from(db.objectStoreNames)) {
        const tudo = await new Promise<unknown[]>((ok) => {
          const req = db.transaction(store, "readonly").objectStore(store).getAll();
          req.onsuccess = () => ok(req.result as unknown[]);
          req.onerror = () => ok([]);
        });
        for (const item of tudo) {
          const bruto = JSON.stringify(item, (_k, v) =>
            v instanceof Blob ? "__BLOB__" : v
          );
          if (bruto.includes("__BLOB__") || suspeito(bruto)) {
            relatorio.push({ onde: `idb:${name}/${store}`, chave: bruto.slice(0, 90) });
          }
        }
      }
      db.close();
    }
    return relatorio;
  });

  expect(
    achados,
    `armazenamento com resíduo de áudio: ${JSON.stringify(achados)}`
  ).toEqual([]);

  // E o dispositivo foi devolvido: nenhuma trilha continua viva.
  const visto = await espiao(page);
  expect(visto.trilhasParadas).toBeGreaterThan(0);
  expect(visto.streamsAbertos).toBe(visto.trilhasParadas);
});
