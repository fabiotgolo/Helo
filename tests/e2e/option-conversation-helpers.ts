// ——— Atalhos de fluxo da conversa por opções ———
// Reusa integralmente tests/e2e/helpers.ts (semeadura, login e paciente ativo)
// e acrescenta só o que é específico deste modo.

import { expect, type Page } from "@playwright/test";
import { abrirModo, iniciarNovaSessao, pularContexto } from "./helpers";

/** Abre a sessão e entra na conversa por opções pela entrada manual. */
export async function iniciarConversaPorOpcoes(
  page: Page,
  patientId: number
): Promise<void> {
  await abrirModo(page, patientId);
  await iniciarNovaSessao(page);
  await pularContexto(page);
  await expect(
    page.getByRole("heading", { name: "Escreva a pergunta" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Conversa por opções" }).click();
  await expect(
    page.getByRole("heading", { name: /Criar o primeiro nível/ })
  ).toBeVisible();
}

export interface NivelInput {
  titulo: string;
  opcoes: string[];
  /** Índice (base 0) da opção que encerra o caminho. */
  terminal?: number;
  fraseFinal?: string;
  sensivel?: boolean;
}

/** Preenche o editor de nível e apresenta ao paciente. */
export async function criarNivel(
  page: Page,
  { titulo, opcoes, terminal, fraseFinal, sensivel }: NivelInput
): Promise<void> {
  await page.getByLabel("Título ou pergunta do nível").fill(titulo);
  for (let i = 0; i < opcoes.length; i++) {
    if (i > 0) {
      await page.getByRole("button", { name: "+ Adicionar opção" }).click();
    }
    await page
      .getByLabel(new RegExp(`^Opção ${i + 1}`))
      .fill(opcoes[i]);
  }
  if (terminal != null) {
    await page
      .getByRole("checkbox", { name: /Esta opção encerra o caminho/ })
      .nth(terminal)
      .check();
    if (fraseFinal) {
      await page
        .getByLabel(`Frase final da opção ${terminal + 1}`)
        .fill(fraseFinal);
    }
  }
  if (sensivel) {
    await page
      .getByRole("checkbox", { name: /trata de um assunto sensível/ })
      .check();
  }
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText("Revisar antes de apresentar")).toBeVisible();
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await expect(
    page.getByRole("group", { name: "Opções apresentadas ao paciente" })
  ).toBeVisible();
}

/** Botão de uma opção apresentada, pelo seu texto. */
export function opcao(page: Page, label: string) {
  return page.getByRole("button", { name: new RegExp(`^${label}:`) });
}

/** Botão de uma resposta semântica na confirmação da frase. */
export function resposta(page: Page, nome: "SIM" | "TALVEZ" | "NÃO") {
  return page.getByRole("button", { name: new RegExp(`^${nome}:`) });
}

/** Seleciona a opção e confere a correspondência com o gesto observado. */
export async function confirmarOpcao(page: Page, label: string): Promise<void> {
  await opcao(page, label).click();
  await expect(page.getByText(`Opção observada: ${label}`)).toBeVisible();
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
}

/** Degrau clicável do breadcrumb. */
export function degrau(page: Page, texto: string) {
  return page.getByRole("button", { name: new RegExp(`^Voltar para .*${texto}`) });
}
