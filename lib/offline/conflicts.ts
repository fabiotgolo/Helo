// ——— A matriz de conflitos (Fase 4.9.3-C, §10 da auditoria) ———
//
// Módulo PURO: sem rede, sem React, sem IndexedDB. Recebe o que o servidor
// respondeu (ou o que a fila já sabe) e devolve QUAL das treze situações da
// matriz aconteceu. Nada aqui decide o que fazer — decidir é do cuidador, na
// tela que vem depois. Aqui só se dá NOME ao que houve.
//
// ——— Por que isto existe como camada própria ———
//
// A Fase B marcava CONFLICT com uma frase: "O servidor recusou esta ação."
// Uma frase não permite oferecer decisão nenhuma. Para dizer ao cuidador
// *"esta conversa foi encerrada em outro aparelho às 14:35; o que você
// registrou aqui não entrou"*, é preciso saber que foi o caso 1 — e não o 3,
// nem o 5 — e ter em mãos o horário.
//
// ——— A regra que governa o arquivo inteiro ———
//
// §10, primeira linha: **nenhum conflito é resolvido silenciosamente.** Por
// isso não existe aqui nenhuma função que "resolva" nada, e não existe caso
// padrão que aplique por cima. Um conflito que este módulo não souber
// classificar vira `DESCONHECIDO` — que também para a fila e também pede
// decisão. Errar para o lado de perguntar é barato; errar para o lado de
// aplicar sozinho é irreversível num prontuário.
//
// ——— As três portas de entrada ———
//
// As treze linhas da matriz não chegam todas pelo mesmo caminho, e fingir que
// sim produziria um classificador que mente:
//
//   1. ANTES DE ENVIAR (casos 8 e 13) — a própria fila já sabe. Paciente
//      diferente do ativo, ou dependência que não sincronizou. Não custa uma
//      requisição descobrir, e mandar assim mesmo seria pedir ao servidor que
//      recusasse algo que nunca deveria ter saído daqui.
//
//   2. NA RESPOSTA DO SERVIDOR (casos 1–7 e 9) — só o servidor sabe que a
//      sessão foi concluída em outro aparelho. Chega como `code`, nunca como
//      texto: ver a nota sobre códigos, abaixo.
//
//   3. NÃO É CONFLITO (casos 10, 11 e 12) — a matriz diz isso com todas as
//      letras. Ledger que responde, ou servidor mais novo SEM divergência de
//      conteúdo, seguem em frente. Estão modelados aqui, e não omitidos,
//      porque "isto não é conflito" é uma decisão que precisa ser explícita e
//      testável — senão vira um `else` que alguém, um dia, transforma em tela.
//
// ——— Por que `code`, e não a mensagem ———
//
// O servidor sempre soube distinguir estes casos; ele só nunca precisou
// DIZER. Classificar no cliente por leitura da frase em português
// ("transição de sessão inválida: COMPLETED → PAUSED") acoplaria a decisão
// clínica à redação de uma mensagem de erro: bastaria alguém melhorar o texto
// para o produto voltar, em silêncio, a tratar tudo como conflito genérico. O
// código é contrato; a frase é para o humano.

import type { OfflineOperation } from "@/lib/offline/types";
import {
  isRtqConflictCode,
  type RtqConflictCode,
} from "@/lib/realtime-question-types";

// ---------- Códigos que o servidor emite ----------
//
// O vocabulário vive em `realtime-question-types.ts`, junto de quem o EMITE.
// Duas listas — uma no servidor, outra aqui — divergiriam no dia em que
// alguém acrescentasse um caso só de um lado, e a divergência apareceria como
// "conflito desconhecido" em produção, não como erro de compilação.
export { isRtqConflictCode, type RtqConflictCode };

// ---------- Os treze casos ----------

/**
 * Quem resolve o conflito. Não é decoração: é o que a tela usa para saber se
 * pode oferecer botões (`CUIDADOR`), se deve apenas informar e esperar outra
 * coisa acontecer (`ESPERA`), ou se não há nada a decidir (`NENHUMA`).
 */
export type ConflictResolution = "CUIDADOR" | "ESPERA" | "NENHUMA";

/** Dados que o servidor manda junto do código, quando os tem. */
export interface ConflictFacts {
  /** Status atual da entidade no servidor (sessão, caminho, turno…). */
  serverStatus?: string;
  /** Quando o servidor registrou a mudança que causou a divergência. */
  serverAt?: string;
  /** O texto/valor que o SERVIDOR tem. Nunca é aplicado sozinho. */
  serverValue?: string;
  /** Id da entidade que substituiu a original (casos 3 e 6). */
  replacedById?: string;
  /** O que o cuidador registrou aqui, sem conexão (casos 4 e 7). */
  localValue?: string;
}

/**
 * Uma linha da matriz, já identificada e com os fatos que a tela precisa.
 *
 * `caso` é o NÚMERO da linha na §10 do documento de auditoria, de propósito:
 * quem ler o código com o documento ao lado não precisa traduzir nada, e uma
 * linha que sumisse daqui ficaria visivelmente faltando.
 */
export interface ConflictCase {
  caso: number;
  code: RtqConflictCode | "DEPENDENCIA_AUSENTE" | "PACIENTE_DIFERENTE" | "DESCONHECIDO";
  /** Nome curto e estável, para teste e telemetria. Nunca vai à tela. */
  nome: string;
  resolucao: ConflictResolution;
  /** O que a tela diz ao cuidador. Escrito para ele, não para quem depura. */
  titulo: string;
  fatos: ConflictFacts;
  /**
   * As saídas oferecidas, na ordem em que aparecem. A primeira NUNCA é a que
   * aplica por cima — §10: "o padrão nunca é aplicar mesmo assim".
   */
  opcoes: readonly ConflictOption[];
}

/**
 * Uma saída possível. `efeito` é o que a Fase C.2 executará; aqui ele é só
 * declarado — este módulo não executa nada.
 */
export interface ConflictOption {
  id: ConflictOptionId;
  rotulo: string;
  /**
   * Verdadeiro quando esta saída DESCARTA a intenção do cuidador. A tela
   * precisa saber para nunca deixá-la em foco por engano.
   */
  descarta: boolean;
}

export type ConflictOptionId =
  /** Descarta a operação. Sempre disponível, nunca primeira por acidente. */
  | "DESCARTAR"
  /** Mostra o que ficou pendente, sem decidir ainda. */
  | "VER_PENDENTES"
  /** Abre nova conversa e leva os textos como RASCUNHO (nunca confirmação). */
  | "REAPROVEITAR_COMO_RASCUNHO"
  /** Enfileira RESUME antes do resto e continua. */
  | "RETOMAR_E_CONTINUAR"
  /** Refaz a ação sobre a versão nova — operação nova, chave nova. */
  | "REPETIR_SOBRE_A_NOVA"
  /** Mantém o que o servidor tem; a intenção local é descartada. */
  | "MANTER_DO_SERVIDOR"
  /** Aplica a do cuidador como correção, com trilha. Nunca "a mais recente vence". */
  | "APLICAR_A_MINHA"
  /** Grava a minha como versão NOVA (o comportamento normal do 4.8). */
  | "GRAVAR_COMO_NOVA_VERSAO"
  /** Decide sobre a cadeia inteira, não sobre uma peça solta (caso 13). */
  | "DECIDIR_A_CADEIA";

const DESCARTAR: ConflictOption = {
  id: "DESCARTAR",
  rotulo: "Descartar o que ficou aqui",
  descarta: true,
};

// ---------- Porta 1: o que a fila já sabe, antes de enviar ----------

/**
 * Caso 8 — paciente diferente.
 *
 * Não é "a fila errou": é a única resposta correta quando o cuidador trocou de
 * paciente com coisa pendente do anterior. A fila daquele paciente espera
 * ELE ser selecionado de novo. Nunca grava no paciente errado — que é o pior
 * erro que este produto pode cometer.
 */
export function conflitoPacienteDiferente(
  pacienteDaFila: string,
  pacienteAtivo: string
): ConflictCase {
  return {
    caso: 8,
    code: "PACIENTE_DIFERENTE",
    nome: "paciente-diferente",
    resolucao: "ESPERA",
    titulo: "Há registros de outro paciente aguardando conexão.",
    fatos: { serverValue: pacienteDaFila, localValue: pacienteAtivo },
    // Sem opções: não há o que decidir. Selecionar o paciente de novo resolve
    // sozinho, e oferecer "descartar" aqui convidaria a jogar fora registro
    // clínico só porque a tela estava em outro paciente.
    opcoes: [],
  };
}

/**
 * Caso 13 — dependência ausente.
 *
 * A tela explica a CADEIA inteira, não a peça solta: "não foi possível
 * registrar o nível; por isso a opção escolhida também não foi". O cuidador
 * decide sobre o conjunto — decidir sobre a peça de baixo, sem ver a de cima,
 * é decidir no escuro.
 */
export function conflitoDependenciaAusente(
  bloqueada: OfflineOperation,
  causa: OfflineOperation | null
): ConflictCase {
  const causaTravou =
    causa !== null && (causa.status === "CONFLICT" || causa.status === "FAILED");
  return {
    caso: 13,
    code: "DEPENDENCIA_AUSENTE",
    nome: "dependencia-ausente",
    // Só vira decisão do cuidador quando a dependência TRAVOU. Enquanto ela
    // apenas ainda não foi enviada, isto é espera comum de fila, não conflito.
    resolucao: causaTravou ? "CUIDADOR" : "ESPERA",
    titulo: causaTravou
      ? "Um registro anterior não foi enviado — e por isso este também não foi."
      : "Este registro está aguardando outro, feito antes dele.",
    fatos: {
      serverValue: causa?.operationType,
      localValue: bloqueada.operationType,
    },
    opcoes: causaTravou
      ? [{ id: "DECIDIR_A_CADEIA", rotulo: "Ver e decidir sobre tudo", descarta: false }]
      : [],
  };
}

// ---------- Porta 2: o que o servidor respondeu ----------

/** O que o motor consegue observar de uma resposta HTTP recusada. */
export interface RespostaRecusada {
  status: number;
  code: unknown;
  /** Mensagem em português. Serve para exibir, NUNCA para classificar. */
  mensagem: string;
  fatos?: ConflictFacts;
}

/**
 * Traduz uma recusa do servidor na linha correspondente da matriz.
 *
 * O que NÃO acontece aqui, e é deliberado: nenhuma inspeção da mensagem. Se o
 * servidor não mandou `code`, o resultado é `DESCONHECIDO` — que para a fila
 * e pede decisão exatamente como os outros. É pior mostrar ao cuidador uma
 * tela de "resposta alterada" adivinhada a partir de um texto do que admitir
 * que não sabemos qual foi o problema.
 */
export function classificarRecusa(r: RespostaRecusada): ConflictCase {
  const fatos = r.fatos ?? {};

  // 403 é caso 9 pelo próprio status: o servidor não precisa de código para
  // dizer "você não tem mais acesso", e depender de um código aqui deixaria
  // um 403 sem corpo cair no DESCONHECIDO — perdendo a única situação da
  // matriz em que a fila precisa ficar ilegível para outro usuário.
  if (r.status === 403 || r.code === "ACCESS_REVOKED") {
    return {
      caso: 9,
      code: "ACCESS_REVOKED",
      nome: "acesso-revogado",
      resolucao: "CUIDADOR",
      titulo:
        "Você não tem mais autorização para registrar nesta conversa. Nada foi enviado.",
      fatos,
      // §10 caso 9: "não há opção de forçar". A fila é preservada (e ilegível
      // para outro usuário, pelo AAD) e some no logout.
      opcoes: [DESCARTAR],
    };
  }

  if (!isRtqConflictCode(r.code)) {
    return {
      caso: 0,
      code: "DESCONHECIDO",
      nome: "desconhecido",
      resolucao: "CUIDADOR",
      titulo: "O servidor recusou este registro, e não sabemos dizer por quê.",
      fatos: { ...fatos, serverValue: r.mensagem },
      opcoes: [DESCARTAR],
    };
  }

  switch (r.code) {
    case "SESSION_COMPLETED":
      return {
        caso: 1,
        code: r.code,
        nome: "sessao-concluida",
        resolucao: "CUIDADOR",
        titulo: "Esta conversa foi encerrada em outro aparelho. O que você registrou aqui não entrou.",
        fatos,
        opcoes: [
          { id: "VER_PENDENTES", rotulo: "Ver o que ficou pendente", descarta: false },
          {
            id: "REAPROVEITAR_COMO_RASCUNHO",
            rotulo: "Iniciar nova conversa com estes textos",
            descarta: false,
          },
          DESCARTAR,
        ],
      };

    case "SESSION_PAUSED":
      return {
        caso: 2,
        code: r.code,
        nome: "sessao-pausada",
        resolucao: "CUIDADOR",
        titulo: "A conversa foi pausada em outro aparelho.",
        fatos,
        opcoes: [
          {
            id: "RETOMAR_E_CONTINUAR",
            rotulo: "Retomar e continuar a enviar",
            descarta: false,
          },
          DESCARTAR,
        ],
      };

    case "TURN_REPLACED":
      return {
        caso: 3,
        code: r.code,
        nome: "pergunta-substituida",
        resolucao: "CUIDADOR",
        titulo: "Esta pergunta foi substituída por outra versão.",
        fatos,
        opcoes: [
          // "Descartar minha ação" vem primeiro aqui de propósito: §10 caso 3
          // diz que a ação NUNCA é aplicada automaticamente sobre a
          // substituta, e repetir sobre ela é o passo mais forte dos dois.
          DESCARTAR,
          {
            id: "REPETIR_SOBRE_A_NOVA",
            rotulo: "Repetir sobre a nova versão",
            descarta: false,
          },
        ],
      };

    case "RESPONSE_CHANGED":
      return {
        caso: 4,
        code: r.code,
        nome: "resposta-alterada",
        resolucao: "CUIDADOR",
        titulo: "A resposta registrada no servidor é diferente da que você viu aqui.",
        fatos,
        opcoes: [
          { id: "MANTER_DO_SERVIDOR", rotulo: "Manter a do servidor", descarta: true },
          // Vira CHANGE_RESPONSE — contabilizada como CORREÇÃO, com trilha.
          // Jamais um "a mais recente vence" silencioso.
          { id: "APLICAR_A_MINHA", rotulo: "Aplicar a minha, como correção", descarta: false },
        ],
      };

    case "PATH_ENDED":
      return {
        caso: 5,
        code: r.code,
        nome: "caminho-encerrado",
        resolucao: "CUIDADOR",
        titulo: "Este caminho foi encerrado.",
        fatos,
        opcoes: [
          DESCARTAR,
          {
            id: "REAPROVEITAR_COMO_RASCUNHO",
            rotulo: "Reutilizar o conteúdo num caminho novo",
            descarta: false,
          },
        ],
      };

    case "STATEMENT_REPLACED":
      return {
        caso: 6,
        code: r.code,
        nome: "interpretacao-substituida",
        resolucao: "CUIDADOR",
        // Caso 6 é o 3 com um dever a mais: a tela precisa dizer QUEM formulou
        // cada texto. Interpretação do cuidador não é fala do paciente, e
        // apagar essa fronteira é o risco central da Fase 4.6.
        titulo: "Esta interpretação foi substituída por outra versão.",
        fatos,
        opcoes: [
          DESCARTAR,
          { id: "REPETIR_SOBRE_A_NOVA", rotulo: "Repetir sobre a nova versão", descarta: false },
        ],
      };

    case "CONTEXT_VERSION":
      return {
        caso: 7,
        code: r.code,
        nome: "contexto-alterado",
        resolucao: "CUIDADOR",
        titulo: "O contexto da conversa mudou no servidor.",
        fatos,
        opcoes: [
          { id: "MANTER_DO_SERVIDOR", rotulo: "Manter a do servidor", descarta: true },
          // Versionar, não sobrescrever — é o que o 4.8 já faz online.
          {
            id: "GRAVAR_COMO_NOVA_VERSAO",
            rotulo: "Gravar a minha como versão nova",
            descarta: false,
          },
        ],
      };

    case "IDEMPOTENCY_MISMATCH":
      return {
        caso: 12,
        code: r.code,
        nome: "chave-reutilizada",
        resolucao: "CUIDADOR",
        // Repetir NÃO resolve: é a mesma colisão de novo. Por isso vira
        // decisão, e não retentativa — a Fase B já tratava assim, e aqui o
        // caso ganha nome.
        titulo: "Este registro foi enviado antes com um conteúdo diferente.",
        fatos,
        opcoes: [DESCARTAR],
      };

    // Já tratado lá em cima, pelo status 403 — que é como ele chega na prática,
    // com ou sem corpo. O ramo existe para o `switch` ser exaustivo: assim,
    // um código NOVO na lista quebra a compilação aqui em vez de virar,
    // silenciosamente, um "conflito desconhecido" em produção.
    case "ACCESS_REVOKED":
      return classificarRecusa({ ...r, status: 403 });
  }
}

// ---------- Porta 3: o que NÃO é conflito ----------

/**
 * Casos 10, 11 e 12-como-reenvio. Modelados como resultado explícito para que
 * "seguir em frente" seja uma decisão nomeada, e não a ausência de uma.
 */
export type NaoConflito =
  /** 10 e 12 — o ledger respondeu: já aplicada. Sem tela, sem duplicar. */
  | { kind: "JA_APLICADA"; caso: 10 | 12 }
  /** 11 — servidor mais novo, SEM divergência de conteúdo. Só atualiza. */
  | { kind: "SNAPSHOT_DESATUALIZADO"; caso: 11 };

/**
 * Caso 11 x caso 4 — a fronteira mais delicada da matriz.
 *
 * Servidor mais novo NÃO é conflito por si só: o cuidador pode ter recarregado
 * noutro aparelho sem mudar nada. Vira conflito quando o CONTEÚDO diverge.
 * Tratar "mais novo" como conflito encheria a tela de decisões vazias;
 * tratá-lo como "sem conflito" apagaria o caso 4. A diferença é o conteúdo, e
 * é por isso que esta função pede os dois valores, não os dois horários.
 */
export function classificarVersaoServidor(
  valorLocal: string | null,
  valorServidor: string | null
): NaoConflito | "DIVERGE" {
  if (valorLocal === null || valorServidor === null) {
    return { kind: "SNAPSHOT_DESATUALIZADO", caso: 11 };
  }
  return valorLocal === valorServidor
    ? { kind: "SNAPSHOT_DESATUALIZADO", caso: 11 }
    : "DIVERGE";
}

// ---------- O outro lado da tela ----------

/**
 * O valor que o CUIDADOR registrou aqui, para os casos que mostram os dois
 * lados (4 e 7).
 *
 * O servidor manda o lado dele (`serverValue`) e não tem como mandar este: a
 * intenção local nunca chegou lá. Sem esta função a tela do caso 4 diria "o
 * servidor tem SIM" sem dizer o que o cuidador tinha registrado — que é
 * exatamente a metade que faz a decisão ser possível.
 *
 * Lê o payload de forma deliberadamente rasa: só os campos que estas duas
 * linhas da matriz precisam. Um leitor genérico de payload aqui viraria, com o
 * tempo, uma segunda definição de "o que a operação significa".
 */
export function valorLocalDe(op: {
  operationType: string;
  payload: unknown;
}): string | null {
  const p = (op.payload ?? {}) as Record<string, unknown>;

  if (op.operationType === "turnAction") {
    const acao = (p.action ?? {}) as Record<string, unknown>;
    return typeof acao.response === "string" ? acao.response : null;
  }

  if (op.operationType === "saveSessionContext") {
    if (p.skipped === true) return "Sem contexto registrado.";
    const texto = (chave: string, rotulo: string) =>
      typeof p[chave] === "string" && (p[chave] as string).trim()
        ? `${rotulo}: ${(p[chave] as string).trim()}`
        : null;
    const partes = [
      texto("interlocutorName", "Com"),
      texto("intention", "Intenção"),
      texto("environment", "Ambiente"),
      texto("initialTopic", "Assunto"),
      texto("notes", "Notas"),
    ].filter(Boolean);
    return partes.length > 0 ? partes.join(" · ") : "Sem contexto registrado.";
  }

  return null;
}

/** O mesmo conflito, com o lado do cuidador preenchido. Puro. */
export function comValorLocal(
  conflito: ConflictCase,
  valorLocal: string | null
): ConflictCase {
  if (!valorLocal) return conflito;
  return { ...conflito, fatos: { ...conflito.fatos, localValue: valorLocal } };
}

// ---------- Leitura ----------

/** Um conflito que exige o cuidador — o que faz o chip parar de sumir sozinho. */
export function exigeDecisao(c: ConflictCase): boolean {
  return c.resolucao === "CUIDADOR";
}

/**
 * Valida um conflito lido do banco local. Mesmo critério de
 * `restoreOperation`: o que não for reconhecível é descartado, nunca
 * adivinhado — mas descartar AQUI só apaga a explicação, não a operação, que
 * continua CONFLICT e continua pedindo decisão.
 */
export function restoreConflict(bruto: unknown): ConflictCase | null {
  if (bruto === null || typeof bruto !== "object") return null;
  const v = bruto as Record<string, unknown>;
  if (typeof v.nome !== "string" || typeof v.titulo !== "string") return null;
  if (typeof v.caso !== "number") return null;
  if (v.resolucao !== "CUIDADOR" && v.resolucao !== "ESPERA" && v.resolucao !== "NENHUMA") {
    return null;
  }
  return {
    caso: v.caso,
    code: (v.code ?? "DESCONHECIDO") as ConflictCase["code"],
    nome: v.nome,
    resolucao: v.resolucao,
    titulo: v.titulo,
    fatos: (v.fatos ?? {}) as ConflictFacts,
    opcoes: Array.isArray(v.opcoes) ? (v.opcoes as ConflictOption[]) : [],
  };
}
