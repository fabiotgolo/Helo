// ——— O rascunho não se perde na saída (correção autorizada na 5.3C) ———
//
// A regressão final da 5.3C revelou perda SILENCIOSA: ditar (ou digitar) e
// recarregar em seguida devolvia o campo vazio. O defeito é anterior — a
// mesma taxa foi medida em `c01eea3`, o fim da 5.2C — e nada tinha a ver com
// o Agent nem com o STT: a causa estava no mecanismo COMPARTILHADO de
// rascunho, que o ditado apenas exercita mais rápido que o teclado.
//
// A investigação mediu, envolvendo `IDBObjectStore.prototype.put`, que a
// gravação chegava a ser disparada e mesmo assim a leitura seguinte voltava
// vazia; e, instrumentando a hidratação, que na execução que falha ela recebe
// `{}`. Entre "disparada" e "guardada" existe uma transação, e a recarga a
// interrompia.
//
// Estes testes prendem o comportamento pelos DOIS lados: o texto sobrevive à
// recarga imediata, e continua desaparecendo quando deve desaparecer. Nenhum
// deles usa espera artificial entre a alteração e a recarga — é justamente
// essa janela que eles existem para exercitar.

import { expect, test, type Page } from "@playwright/test";
import {
  abrirModo,
  entrarComo,
  iniciarNovaSessao,
  pularContexto,
  selecionarPaciente,
  semear,
  type Semente,
} from "./helpers";
import { ditar, instalarMicrofone, interceptarTranscricao } from "./dictation-helpers";

let dados: Semente;

const campo = (page: Page) => page.getByLabel("Pergunta para o paciente");

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await instalarMicrofone(page);
  await entrarComo(page, dados.assistente.email);
});

/** Abre a tela de escrever a pergunta, com uma sessão nova. */
async function compositor(page: Page, patientId = dados.pacienteId) {
  await abrirModo(page, patientId);
  await iniciarNovaSessao(page);
  await pularContexto(page);
  await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();
}

/** Recarrega e volta ao compositor pela retomada local. */
async function recarregarERetomar(page: Page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Retomar sessão de/ }).click();
  await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();
}

test("1. texto digitado sobrevive à recarga imediata", async ({ page }) => {
  await compositor(page);
  await campo(page).fill("O senhor está com sede?");
  // Sem espera nenhuma: é esta a janela que revelava o defeito.
  await recarregarERetomar(page);
  await expect(campo(page)).toHaveValue("O senhor está com sede?");
});

test("2. texto ditado sobrevive à recarga imediata", async ({ page }) => {
  await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "O senhor quer ver a sua filha?" },
  }));
  await compositor(page);
  await ditar(page);
  await expect(campo(page)).toHaveValue("O senhor quer ver a sua filha?");
  await recarregarERetomar(page);
  await expect(campo(page)).toHaveValue("O senhor quer ver a sua filha?");
});

test("3. o caminho é o mesmo para as duas origens", async ({ page }) => {
  // Digitar e ditar não podem ter persistências diferentes: é o mesmo campo,
  // o mesmo rascunho e a mesma promessa ao cuidador.
  await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: " e quer água?" },
  }));
  await compositor(page);
  await campo(page).fill("O senhor está bem");
  await ditar(page);
  // Esperar o texto COMPLETO antes de ler: `ditar` volta quando a captura
  // termina, e a transcrição chega ao campo logo depois.
  const combinado = "O senhor está bem e quer água?";
  await expect(campo(page)).toHaveValue(combinado);
  await recarregarERetomar(page);
  await expect(campo(page)).toHaveValue(combinado);
});

test("4. numa rajada de alterações, a última vence", async ({ page }) => {
  await compositor(page);
  // Sequência rápida: as intermediárias são coalescidas, a final é a que fica.
  for (const texto of ["a", "ab", "abc", "O senhor quer descansar?"]) {
    await campo(page).fill(texto);
  }
  await recarregarERetomar(page);
  await expect(campo(page)).toHaveValue("O senhor quer descansar?");
});

test("5. o rascunho não se duplica", async ({ page }) => {
  await compositor(page);
  await campo(page).fill("Primeiro");
  await campo(page).fill("Segundo");
  await campo(page).fill("Terceiro");
  await recarregarERetomar(page);
  await expect(campo(page)).toHaveValue("Terceiro");

  // Uma linha por chave, não uma por alteração.
  const quantos = await page.evaluate(async () => {
    const bases = (await indexedDB.databases?.()) ?? [];
    let total = 0;
    for (const { name } of bases) {
      if (!name) continue;
      const db = await new Promise<IDBDatabase | null>((ok) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => ok(req.result);
        req.onerror = () => ok(null);
      });
      if (!db) continue;
      if (db.objectStoreNames.contains("rascunhos")) {
        total += await new Promise<number>((ok) => {
          const req = db.transaction("rascunhos", "readonly").objectStore("rascunhos").count();
          req.onsuccess = () => ok(req.result);
          req.onerror = () => ok(0);
        });
      }
      db.close();
    }
    return total;
  });
  expect(quantos).toBe(1);
});

test("6. limpar o campo continua limpando o rascunho", async ({ page }) => {
  await compositor(page);
  await campo(page).fill("Texto que vai embora");
  await campo(page).fill("");
  await recarregarERetomar(page);
  await expect(campo(page)).toHaveValue("");
});

test("7. o rascunho de um paciente não aparece no outro", async ({ page, request }) => {
  const vinculo = await request.post("/api/admin/access", {
    data: {
      userId: dados.assistente.id,
      patientId: dados.outroPacienteId,
      permissions: ["viewDashboard", "viewSessions", "viewMetrics", "createSession", "editGestures"],
    },
  });
  expect(vinculo.ok(), "vincular a cuidadora ao segundo paciente").toBeTruthy();

  await compositor(page);
  await campo(page).fill("Pergunta do primeiro paciente");

  await selecionarPaciente(page, dados.outroPacienteId);
  await compositor(page, dados.outroPacienteId);
  await expect(campo(page)).toHaveValue("");
});

test("8. sair da conta não leva o rascunho para o próximo login", async ({ page }) => {
  await compositor(page);
  await campo(page).fill("Rascunho da sessão anterior");

  await page.evaluate(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
  });
  await page.goto("/login");

  await entrarComo(page, dados.outroAssistente.email);
  await selecionarPaciente(page, dados.outroPacienteId);
  await abrirModo(page, dados.outroPacienteId);
  await iniciarNovaSessao(page);
  await pularContexto(page);
  await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();
  await expect(campo(page)).toHaveValue("");
});

test("9. o rascunho sobrevive a fechar e reabrir a aba", async ({ page, context }) => {
  await compositor(page);
  await campo(page).fill("O senhor quer sair um pouco?");

  // Uma aba nova, no mesmo contexto: mesmo armazenamento, página do zero.
  const outra = await context.newPage();
  await outra.goto("/conversa/perguntas");
  await outra.getByRole("button", { name: /Retomar sessão de/ }).click();
  await expect(outra.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();
  await expect(outra.getByLabel("Pergunta para o paciente")).toHaveValue(
    "O senhor quer sair um pouco?"
  );
  await outra.close();
});

test("10. a sessão seguinte começa com o campo vazio", async ({ page }) => {
  // O rascunho é da sessão, não do cuidador: começar outra não herda nada.
  await compositor(page);
  await campo(page).fill("Pergunta da primeira sessão");
  await recarregarERetomar(page);
  await expect(campo(page)).toHaveValue("Pergunta da primeira sessão");

  await page.goto("/conversa/perguntas");
  await iniciarNovaSessao(page);
  await pularContexto(page);
  await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();
  await expect(campo(page)).toHaveValue("");
});
