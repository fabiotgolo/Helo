// ——— Catálogo das perguntas da Rotina ———
// A Rotina deixou de ser uma lista de frases soltas: cada card é uma PERGUNTA
// dirigida ao paciente. Ao abrir a pergunta, três respostas (SIM / TALVEZ /
// NÃO) transformam a pergunta na fala DO PACIENTE — dita pela voz dele (clone
// ou voz configurada em Ajustes; resolução técnica é do servidor /api/tts).
//
// O catálogo é fixo e estável: a `key` compõe os actionIds do Action Registry
// (routine.open.<key>, routine.answer.<key>.<yes|maybe|no>), que o Agent Helo
// aciona por tool. A `key` NUNCA deriva do texto visual — o texto é conteúdo,
// a key é identidade.
//
// As três respostas seguem a ordem canônica dos gestos da Helo (SIM, TALVEZ,
// NÃO) e o mesmo significado semântico: 👍 confirmar, ✋ reformular, ✊ recusar.

export type RoutineAnswer = "yes" | "maybe" | "no";

/** Ordem canônica das respostas — sempre SIM, TALVEZ, NÃO. */
export const ROUTINE_ANSWER_ORDER: readonly RoutineAnswer[] = ["yes", "maybe", "no"] as const;

/** Gesto da Helo correspondente a cada resposta (emoji/rótulo já vêm de useGestures). */
export const ROUTINE_ANSWER_TO_GESTURE = {
  yes: "sim",
  maybe: "talvez",
  no: "nao",
} as const;

export interface RoutineQuestion {
  /** Id estável — compõe os actionIds. Nunca derivado do texto visual. */
  key: string;
  /** A pergunta exibida no card e no topo da tela do card. */
  question: string;
  /** Falas DO PACIENTE, uma por resposta. */
  responses: Record<RoutineAnswer, string>;
}

export const ROUTINE_QUESTIONS: readonly RoutineQuestion[] = [
  {
    key: "water",
    question: "Você quer tomar água?",
    responses: {
      yes: "SIM, quero um copo d'água.",
      maybe: "TALVEZ, me traga um copo d'água.",
      no: "NÃO, não estou com sede.",
    },
  },
  {
    key: "bathroom",
    question: "Você quer ir ao banheiro?",
    responses: {
      yes: "SIM, quero ir ao banheiro.",
      maybe: "TALVEZ, me leve ao banheiro por precaução.",
      no: "NÃO, não quero ir ao banheiro agora.",
    },
  },
  {
    key: "pain",
    question: "Você está com dor?",
    responses: {
      yes: "SIM, estou com dor.",
      maybe: "TALVEZ, estou sentindo um desconforto.",
      no: "NÃO, não estou com dor.",
    },
  },
  {
    key: "rest",
    question: "Você quer descansar?",
    responses: {
      yes: "SIM, quero descansar.",
      maybe: "TALVEZ, preciso ficar mais confortável.",
      no: "NÃO, não quero descansar agora.",
    },
  },
  {
    key: "cold",
    question: "Você está com frio?",
    responses: {
      yes: "SIM, estou com frio.",
      maybe: "TALVEZ, me cubra um pouco.",
      no: "NÃO, não estou com frio.",
    },
  },
  {
    key: "hot",
    question: "Você está com calor?",
    responses: {
      yes: "SIM, estou com calor.",
      maybe: "TALVEZ, me deixe um pouco mais fresco.",
      no: "NÃO, não estou com calor.",
    },
  },
  {
    key: "hungry",
    question: "Você está com fome?",
    responses: {
      yes: "SIM, estou com fome.",
      maybe: "TALVEZ, eu comeria alguma coisa leve.",
      no: "NÃO, não estou com fome.",
    },
  },
  {
    key: "good",
    question: "Você está bem?",
    responses: {
      yes: "SIM, estou bem.",
      maybe: "TALVEZ, não sei dizer se estou bem.",
      no: "NÃO, não estou bem.",
    },
  },
  {
    key: "understood",
    question: "Você entendeu?",
    responses: {
      yes: "SIM, eu entendi.",
      maybe: "TALVEZ, explique de outro jeito.",
      no: "NÃO, eu não entendi.",
    },
  },
  {
    key: "isThisWhatYouWant",
    question: "É isso que você quer?",
    responses: {
      yes: "SIM, é isso que eu quero.",
      maybe: "TALVEZ, ainda não é exatamente isso.",
      no: "NÃO, não é isso que eu quero.",
    },
  },
  {
    key: "family",
    question: "Você quer a sua família?",
    responses: {
      yes: "SIM, quero minha família.",
      maybe: "TALVEZ, gostaria de ver alguém da minha família.",
      no: "NÃO, não preciso da minha família agora.",
    },
  },
  {
    key: "changePosition",
    question: "Você quer mudar de posição?",
    responses: {
      yes: "SIM, quero mudar de posição.",
      maybe: "TALVEZ, tente me ajeitar melhor.",
      no: "NÃO, estou confortável assim.",
    },
  },
  {
    key: "walk",
    question: "Você quer ir passear?",
    responses: {
      yes: "SIM, quero ir passear.",
      maybe: "TALVEZ, podemos pensar em sair um pouco.",
      no: "NÃO, não quero passear agora.",
    },
  },
  {
    key: "dessert",
    question: "Você quer sobremesa?",
    responses: {
      yes: "SIM, quero uma sobremesa.",
      maybe: "TALVEZ, eu aceitaria uma sobremesa leve.",
      no: "NÃO, não quero sobremesa agora.",
    },
  },
  {
    key: "sleep",
    question: "Você quer dormir?",
    responses: {
      yes: "SIM, quero dormir.",
      maybe: "TALVEZ, eu descansaria os olhos um pouco.",
      no: "NÃO, não quero dormir agora.",
    },
  },
];

export const ROUTINE_QUESTIONS_BY_KEY: Record<string, RoutineQuestion> = Object.fromEntries(
  ROUTINE_QUESTIONS.map((q) => [q.key, q])
);
