// Banco curado de frases para a construção progressiva de mensagens.
// Usado como ponto de partida; quando disponível, a IA sugere continuações
// contextuais (sempre marcadas e sempre confirmadas pelo paciente).

export interface Frase {
  label: string;
  phrase: string;
}

export const MENSAGEM_POOL: Frase[] = [
  // Abertura
  { label: "Estou feliz em ver vocês", phrase: "Olá, estou feliz em ver vocês." },
  { label: "Obrigado por estarem aqui", phrase: "Obrigado por estarem aqui comigo." },
  { label: "Quero contar uma coisa", phrase: "Quero contar uma coisa para vocês." },
  // Sentimentos
  { label: "Estou emocionado", phrase: "Fico emocionado com a presença de vocês." },
  { label: "Sinto saudade", phrase: "Sinto saudade de vocês todos os dias." },
  { label: "Amo vocês", phrase: "Amo muito vocês." },
  // Gratidão
  { label: "Sou grato pelo cuidado", phrase: "Sou muito grato por todo o cuidado que recebo." },
  { label: "Vocês me fazem bem", phrase: "A companhia de vocês me faz muito bem." },
  { label: "Não estou sozinho", phrase: "Com vocês por perto, nunca me sinto sozinho." },
  // Memórias
  { label: "Lembro de bons tempos", phrase: "Tenho lembranças muito boas dos nossos momentos juntos." },
  { label: "Nossa história importa", phrase: "A nossa história é o que tenho de mais valioso." },
  { label: "Quero relembrar algo", phrase: "Quero relembrar uma história com vocês." },
  // Vontades
  { label: "Quero mais visitas", phrase: "Quero que venham me visitar mais vezes." },
  { label: "Quero ouvir vocês", phrase: "Quero ouvir as novidades de vocês." },
  { label: "Vamos ficar juntos", phrase: "Vamos aproveitar esse tempo juntos." },
];
