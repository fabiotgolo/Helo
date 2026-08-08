// ——— De onde a voz do paciente pode vir ———
//
// A contrapartida do SpeechGrant. O cliente não envia o texto que quer falar:
// ele nomeia um RECURSO, e este módulo — no servidor — responde qual é o texto
// daquele recurso. É o que torna "texto arbitrário na voz do paciente"
// impossível em vez de improvável.
//
// A lista é FECHADA. Acrescentar uma origem é uma decisão explícita, revisável
// em diff, e obriga a responder a mesma pergunta que as outras responderam:
// qual entidade persistida (ou catálogo enumerável) sustenta este texto, e
// como o servidor confere que ele pertence A ESTE paciente.
//
// Origens e suas provas:
//
//   routineAnswer      catálogo fixo em lib/routine.ts — o texto é literal no
//                      código, indexado por (questionKey, answer);
//   emergencyItem      patients/{id}/items, mode=emergencia, habilitado;
//   activityResponse   activityRuns/{runId}.items — snapshot IMUTÁVEL tirado
//                      no início da sessão; getRun já isola por paciente;
//   favoritePhrase     patients/{id}/favoritePhrases;
//   confirmedMessage   messages/{id} com status "confirmada" e speakerRole
//                      "patient" — o registro que a própria tela grava ao
//                      receber o SIM;
//   patientVoicePreview  frase de demonstração COMPOSTA AQUI, nunca enviada
//                      pelo cliente (a prévia de Ajustes era um caminho para
//                      texto livre na voz do clone).
//
// O que NÃO é origem, e não deve virar uma: rascunho, contexto de sessão,
// interpretação não confirmada, texto do Agent, transcrição.

import { getRun } from "@/lib/activity-store";
import { listFavoritePhrases } from "@/lib/favorite-phrases";
import { getMessage, getPatient, listItems } from "@/lib/store";
import { DEFAULT_ITEMS } from "@/lib/defaults";
import { ROUTINE_ANSWER_ORDER, ROUTINE_QUESTIONS_BY_KEY, type RoutineAnswer } from "@/lib/routine";
import { GESTURES, type Gesture } from "@/lib/types";
import type { SpeechGrantOrigin } from "@/lib/voice/speech-grant";

const GESTURE_KEYS = Object.keys(GESTURES) as Gesture[];

export type SpeechSource =
  | { kind: "routineAnswer"; questionKey: string; answer: RoutineAnswer }
  /**
   * `itemId` quando o paciente tem itens próprios; `defaultKey` quando ele
   * ainda usa o conteúdo padrão — que não está persistido em lugar nenhum,
   * mas é enumerável em DEFAULT_ITEMS, e portanto igualmente provável.
   */
  | { kind: "emergencyItem"; itemId?: string; defaultKey?: string }
  | { kind: "activityResponse"; runId: string; itemId: string; optionId: string; gesture: Gesture }
  | { kind: "favoritePhrase"; phraseId: string }
  | { kind: "confirmedMessage"; messageId: string }
  | { kind: "patientVoicePreview" };

export type ResolvedSpeech =
  | { ok: true; text: string; origin: SpeechGrantOrigin }
  | { ok: false; status: number; error: string };

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Valida a FORMA da origem antes de tocar no banco. Uma origem malformada é
 * 400 (pedido inválido); uma origem bem formada que não encontra o recurso é
 * 422 (o recurso não autoriza) — a distinção importa para depurar sem abrir
 * pista sobre a existência de recursos de outros pacientes.
 */
export function parseSpeechSource(value: unknown): SpeechSource | null {
  if (typeof value !== "object" || value === null) return null;
  const s = value as Record<string, unknown>;
  switch (s.kind) {
    case "routineAnswer": {
      const questionKey = str(s.questionKey);
      const answer = str(s.answer) as RoutineAnswer;
      if (!questionKey || !ROUTINE_ANSWER_ORDER.includes(answer)) return null;
      return { kind: "routineAnswer", questionKey, answer };
    }
    case "emergencyItem": {
      const itemId = str(s.itemId);
      const defaultKey = str(s.defaultKey);
      if (!itemId && !defaultKey) return null;
      return {
        kind: "emergencyItem",
        ...(itemId ? { itemId } : {}),
        ...(defaultKey ? { defaultKey } : {}),
      };
    }
    case "activityResponse": {
      const runId = str(s.runId);
      const itemId = str(s.itemId);
      const optionId = str(s.optionId);
      const gesture = str(s.gesture) as Gesture;
      if (!runId || !itemId || !optionId || !GESTURE_KEYS.includes(gesture)) return null;
      return { kind: "activityResponse", runId, itemId, optionId, gesture };
    }
    case "favoritePhrase": {
      const phraseId = str(s.phraseId);
      return phraseId ? { kind: "favoritePhrase", phraseId } : null;
    }
    case "confirmedMessage": {
      const messageId = str(s.messageId);
      return messageId ? { kind: "confirmedMessage", messageId } : null;
    }
    case "patientVoicePreview":
      return { kind: "patientVoicePreview" };
    default:
      return null;
  }
}

const NOT_AUTHORIZED = {
  ok: false as const,
  status: 422,
  error: "a origem informada não autoriza uma fala do paciente",
};

/**
 * Resolve o texto. Quem chama JÁ verificou o vínculo com o paciente — aqui
 * verificamos que o recurso pertence a ele, que é uma pergunta diferente.
 */
export async function resolveSpeechSource(
  patientId: number,
  source: SpeechSource
): Promise<ResolvedSpeech> {
  switch (source.kind) {
    case "routineAnswer": {
      const question = ROUTINE_QUESTIONS_BY_KEY[source.questionKey];
      const text = question?.responses?.[source.answer]?.trim();
      if (!text) return NOT_AUTHORIZED;
      return { ok: true, text, origin: "routineAnswer" };
    }

    case "emergencyItem": {
      const items = await listItems(patientId, "emergencia");
      if (source.itemId) {
        const item = items.find((i) => i.id === source.itemId);
        // Item desabilitado deixou de ser uma ação do paciente: não fala.
        if (!item || !item.enabled || !item.spokenText?.trim()) return NOT_AUTHORIZED;
        return { ok: true, text: item.spokenText.trim(), origin: "emergencyItem" };
      }
      // Conteúdo padrão: só vale enquanto o paciente NÃO tem itens próprios —
      // que é exatamente quando a tela os exibe. Com itens personalizados, os
      // padrões saíram de uso e não podem voltar a falar por uma chave antiga.
      if (items.length > 0) return NOT_AUTHORIZED;
      const fallback = DEFAULT_ITEMS.emergencia.find(
        (d) => d.defaultKey === source.defaultKey
      );
      if (!fallback) return NOT_AUTHORIZED;
      return { ok: true, text: fallback.spokenText, origin: "emergencyItem" };
    }

    case "activityResponse": {
      // getRun devolve null quando a execução é de outro paciente.
      const run = await getRun(patientId, source.runId);
      const text = run?.items
        .find((i) => i.id === source.itemId)
        ?.options.find((o) => o.id === source.optionId)
        ?.responses?.[source.gesture]
        ?.trim();
      if (!text) return NOT_AUTHORIZED;
      return { ok: true, text, origin: "activityResponse" };
    }

    case "favoritePhrase": {
      const phrases = await listFavoritePhrases(patientId);
      const text = phrases.find((p) => p.id === source.phraseId)?.text?.trim();
      if (!text) return NOT_AUTHORIZED;
      return { ok: true, text, origin: "favoritePhrase" };
    }

    case "confirmedMessage": {
      const message = await getMessage(source.messageId);
      // Três verificações, e nenhuma é dispensável: o paciente certo, o
      // registro de fala CONFIRMADA, e a autoria do paciente. Uma mensagem
      // descartada ("rejected") ou da plataforma nunca vira voz dele.
      if (
        !message ||
        Number(message.patientId) !== patientId ||
        message.status !== "confirmada" ||
        message.speakerRole !== "patient" ||
        message.confirmationStatus !== "confirmed" ||
        !message.text?.trim()
      ) {
        return NOT_AUTHORIZED;
      }
      return { ok: true, text: message.text.trim(), origin: "confirmedMessage" };
    }

    case "patientVoicePreview": {
      // A frase da prévia é composta AQUI. Antes vinha do cliente, que podia
      // mandar qualquer coisa e ouvi-la na voz clonada da pessoa.
      const patient = await getPatient(patientId);
      const name = patient?.name?.trim();
      return {
        ok: true,
        text: name
          ? `Olá, eu sou ${name}. Esta será a voz das minhas mensagens.`
          : "Olá. Esta será a voz das minhas mensagens.",
        origin: "patientVoicePreview",
      };
    }
  }
}
