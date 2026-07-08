// Motor de conversa do Helo.
//
// Princípios que este módulo garante por construção:
// - no máximo 3 opções visíveis por vez (lotes de 3);
// - o app nunca deduz: cada avanço exige um gesto registrado;
// - toda frase final passa por confirmação (dupla se sensível);
// - a direção da conversa pertence ao paciente — sempre há saída
//   ("nenhuma dessas", voltar, pausar, encerrar).

export type Target = { next: string } | { phrase: string };

export interface Option {
  label: string;
  /** Variáveis acumuladas no contexto da conversa (ex.: local da dor). */
  set?: Record<string, string>;
  next?: string;
  /** Frase final — template com {variáveis} do contexto. */
  phrase?: string;
}

interface BaseNode {
  id: string;
  category:
    | "geral"
    | "sentimentos"
    | "dor"
    | "conforto"
    | "necessidades"
    | "pessoas"
    | "importante";
  question: string;
  sensitive?: boolean;
}

export interface QuestionNode extends BaseNode {
  kind: "pergunta";
  sim: Target;
  nao: Target;
  talvez: Target;
}

export interface OptionsNode extends BaseNode {
  kind: "opcoes";
  options: Option[];
}

export type FlowNode = QuestionNode | OptionsNode;

export function compose(template: string, ctx: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => ctx[k] ?? "");
}

const nodes: FlowNode[] = [
  {
    kind: "opcoes",
    id: "inicio",
    category: "geral",
    question: "O que você quer comunicar?",
    options: [
      { label: "Como estou me sentindo", next: "sentimentos" },
      { label: "Preciso de algo", next: "necessidades" },
      { label: "Dor ou desconforto", next: "dor_pergunta" },
      { label: "Falar com alguém", next: "pessoas" },
      { label: "Um assunto importante", next: "importantes" },
      { label: "Encerrar a conversa", phrase: "Quero encerrar a conversa por agora. Obrigado." },
    ],
  },

  // ——— Sentimentos ———
  {
    kind: "opcoes",
    id: "sentimentos",
    category: "sentimentos",
    question: "Como você está se sentindo?",
    options: [
      { label: "Bem", phrase: "Estou me sentindo bem." },
      { label: "Cansado", phrase: "Estou cansado." },
      { label: "Animado", phrase: "Estou me sentindo animado hoje." },
      { label: "Triste", phrase: "Estou me sentindo triste." },
      { label: "Preocupado", next: "preocupado" },
      { label: "Com saudade", next: "saudade" },
    ],
  },
  {
    kind: "opcoes",
    id: "preocupado",
    category: "sentimentos",
    question: "Preocupado com o quê?",
    options: [
      { label: "Com a minha saúde", phrase: "Estou preocupado com a minha saúde." },
      { label: "Com a minha família", phrase: "Estou preocupado com a minha família." },
      {
        label: "Com outra coisa",
        phrase: "Estou preocupado com uma coisa. Quero conversar sobre isso.",
      },
    ],
  },
  {
    kind: "opcoes",
    id: "saudade",
    category: "sentimentos",
    question: "Saudade de quem, ou do quê?",
    options: [
      { label: "Da família", phrase: "Estou com saudade da família." },
      { label: "De um amigo", phrase: "Estou com saudade de um amigo." },
      { label: "De outros tempos", phrase: "Estou com saudade de outros tempos." },
    ],
  },

  // ——— Dor e conforto ———
  {
    kind: "pergunta",
    id: "dor_pergunta",
    category: "dor",
    question: "Você está com dor?",
    sim: { next: "dor_onde" },
    nao: { next: "desconforto" },
    talvez: { next: "dor_leve" },
  },
  {
    kind: "pergunta",
    id: "dor_leve",
    category: "dor",
    question: "Sente algum incômodo, mesmo que leve?",
    sim: { next: "dor_onde" },
    nao: { next: "desconforto" },
    talvez: { next: "desconforto" },
  },
  {
    kind: "opcoes",
    id: "dor_onde",
    category: "dor",
    question: "Onde é a dor?",
    options: [
      { label: "Dor de cabeça?", set: { local: "de cabeça" }, next: "dor_intensidade" },
      { label: "Dor de garganta?", set: { local: "de garganta" }, next: "dor_intensidade" },
      { label: "Dor de ouvido?", set: { local: "de ouvido" }, next: "dor_intensidade" },
      { label: "No peito?", set: { local: "no peito" }, next: "dor_intensidade" },
      { label: "Na barriga?", set: { local: "na barriga" }, next: "dor_intensidade" },
      { label: "Nas costas?", set: { local: "nas costas" }, next: "dor_intensidade" },
      { label: "Nas pernas?", set: { local: "nas pernas" }, next: "dor_intensidade" },
      { label: "Nos braços?", set: { local: "nos braços" }, next: "dor_intensidade" },
      { label: "Em outro lugar", set: { local: "em outro lugar" }, next: "dor_intensidade" },
    ],
  },
  {
    kind: "opcoes",
    id: "dor_intensidade",
    category: "dor",
    question: "Como é essa dor?",
    options: [
      { label: "Leve", phrase: "Estou com uma dor leve {local}." },
      { label: "Moderada", phrase: "Estou com uma dor moderada {local}." },
      {
        label: "Forte",
        phrase: "Estou com uma dor forte {local}. Preciso de atenção agora.",
      },
    ],
  },
  {
    kind: "opcoes",
    id: "desconforto",
    category: "conforto",
    question: "Algum desconforto?",
    options: [
      {
        label: "Quero mudar de posição",
        phrase: "Estou desconfortável. Quero mudar de posição, por favor.",
      },
      { label: "Frio ou calor", next: "temperatura" },
      { label: "Estou bem", phrase: "Estou bem, sem dor e sem desconforto." },
    ],
  },
  {
    kind: "opcoes",
    id: "temperatura",
    category: "conforto",
    question: "Frio ou calor?",
    options: [
      { label: "Frio", phrase: "Estou com frio. Quero me agasalhar." },
      { label: "Calor", phrase: "Estou com calor. Quero me refrescar." },
      { label: "Nenhum dos dois", phrase: "A temperatura está boa." },
    ],
  },

  // ——— Necessidades ———
  {
    kind: "opcoes",
    id: "necessidades",
    category: "necessidades",
    question: "O que você precisa?",
    options: [
      { label: "Água", phrase: "Quero água, por favor." },
      { label: "Comer algo", phrase: "Quero comer algo." },
      { label: "Ir ao banheiro", phrase: "Preciso ir ao banheiro." },
      { label: "Descansar", phrase: "Quero descansar agora." },
      { label: "Companhia", phrase: "Quero companhia. Fiquem comigo um pouco." },
      { label: "Um pouco de silêncio", phrase: "Quero um pouco de silêncio, por favor." },
      { label: "Pegar um objeto", phrase: "Quero pegar um objeto. Podem me ajudar?" },
      { label: "Meu remédio", phrase: "Quero saber do meu remédio." },
      { label: "Outra coisa", phrase: "Preciso de outra coisa. Vou mostrar com gestos." },
    ],
  },

  // ——— Pessoas ———
  {
    kind: "opcoes",
    id: "pessoas",
    category: "pessoas",
    question: "Com quem você quer falar?",
    options: [
      { label: "Minha esposa", set: { pessoa: "minha esposa" }, next: "pessoas_mensagem" },
      { label: "Meus filhos", set: { pessoa: "meus filhos" }, next: "pessoas_mensagem" },
      { label: "Meus netos", set: { pessoa: "meus netos" }, next: "pessoas_mensagem" },
      { label: "Um amigo", set: { pessoa: "um amigo" }, next: "pessoas_mensagem" },
      { label: "Meu médico", set: { pessoa: "meu médico" }, next: "pessoas_mensagem" },
      { label: "Outra pessoa", set: { pessoa: "outra pessoa" }, next: "pessoas_mensagem" },
    ],
  },
  {
    kind: "opcoes",
    id: "pessoas_mensagem",
    category: "pessoas",
    question: "O que você quer dizer?",
    options: [
      { label: "Venha aqui, por favor", phrase: "Quero que {pessoa} venha aqui, por favor." },
      { label: "Estou com saudade", phrase: "Quero dizer para {pessoa} que estou com saudade." },
      {
        label: "Obrigado pelo cuidado",
        phrase: "Quero agradecer {pessoa} por cuidar de mim.",
      },
      {
        label: "Estou pensando em você",
        phrase: "Quero dizer para {pessoa} que estou pensando nela.",
      },
      {
        label: "Quero contar uma coisa",
        phrase: "Quero contar uma coisa para {pessoa} quando estivermos juntos.",
      },
    ],
  },

  // ——— Assuntos importantes (confirmação reforçada) ———
  {
    kind: "opcoes",
    id: "importantes",
    category: "importante",
    question: "Sobre qual assunto importante?",
    sensitive: true,
    options: [
      {
        label: "Minha saúde e tratamento",
        phrase: "Quero conversar sobre a minha saúde e o meu tratamento.",
      },
      {
        label: "Uma decisão da família",
        phrase: "Quero participar de uma decisão da família.",
      },
      {
        label: "Outro assunto sério",
        phrase: "Tenho um assunto sério para tratar. Peço atenção para isso.",
      },
    ],
  },
];

export const flow: Record<string, FlowNode> = Object.fromEntries(
  nodes.map((n) => [n.id, n])
);

export const START_NODE = "inicio";

// ——— Modo rotina: frases rápidas, funcionam sem IA ———
export const ROTINA: { label: string; phrase: string; category: string }[] = [
  { label: "Água", phrase: "Quero água, por favor.", category: "necessidades" },
  { label: "Banheiro", phrase: "Preciso ir ao banheiro.", category: "necessidades" },
  { label: "Estou com dor", phrase: "Estou com dor.", category: "dor" },
  { label: "Quero descansar", phrase: "Quero descansar agora.", category: "necessidades" },
  { label: "Estou com frio", phrase: "Estou com frio.", category: "conforto" },
  { label: "Estou com calor", phrase: "Estou com calor.", category: "conforto" },
  { label: "Estou bem", phrase: "Estou bem.", category: "sentimentos" },
  { label: "Estou cansado", phrase: "Estou cansado.", category: "sentimentos" },
  { label: "Não entendi", phrase: "Não entendi. Pode repetir?", category: "geral" },
  { label: "Repita, por favor", phrase: "Repita, por favor.", category: "geral" },
  { label: "Não é isso", phrase: "Não é isso que eu quis dizer.", category: "geral" },
  { label: "Quero minha família", phrase: "Quero falar com a minha família.", category: "pessoas" },
];

// ——— Modo emergência: sempre disponível, não depende de IA ———
export const EMERGENCIA: { label: string; phrase: string }[] = [
  { label: "Falta de ar", phrase: "Estou com falta de ar. Preciso de ajuda agora." },
  { label: "Dor forte", phrase: "Estou com uma dor forte. Preciso de ajuda agora." },
  { label: "Preciso de ajuda", phrase: "Preciso de ajuda agora." },
  { label: "Chamem alguém", phrase: "Quero que chamem alguém agora, por favor." },
  { label: "Não estou bem", phrase: "Não estou me sentindo bem. Fiquem comigo." },
];
