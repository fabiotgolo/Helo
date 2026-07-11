import Anthropic from "@anthropic-ai/sdk";
import { requireUser } from "@/lib/auth";

// Gera até 3 novas opções quando as opções curadas se esgotam.
// Transparência: o cliente marca essas opções como "sugeridas por IA".
// Sem ANTHROPIC_API_KEY, responde 503 e a conversa segue só com a árvore curada.

const SYSTEM = `Você gera opções de comunicação para o Helo, um app de comunicação assistiva usado por uma pessoa com Parkinson que não consegue falar. O paciente responde por gestos (sim/não/talvez) a opções lidas em voz alta.

Regras absolutas:
- Gere no máximo 3 opções.
- Cada opção tem "label" (curto, lido em voz alta, pode ser pergunta) e "phrase" (a frase final em primeira pessoa, como o paciente falaria — adulta, digna, direta, nunca infantilizada).
- As opções devem ser alternativas plausíveis ao que o paciente já rejeitou — não repita opções rejeitadas.
- Nunca sugira decisões médicas, legais ou financeiras definitivas.
- Se o tema for sensível (dinheiro, herança, decisões médicas, conflitos, despedidas), marque "sensitive": true.
- Quando houver um perfil do paciente, use-o apenas para adequar estilo, vocabulário e assuntos — nunca invente memórias, fatos ou sentimentos como se fossem do paciente, e nunca sugira temas listados como evitados.
- Responda em português brasileiro.`;

interface SuggestRequest {
  question: string;
  category: string;
  rejected: string[];
  path: { question: string; answer: string }[];
  draft?: string[];
  /** Perfil de comunicação do paciente — personaliza as sugestões sem
   *  nunca substituir a confirmação por gesto. */
  profile?: {
    name?: string;
    speechStyle?: string;
    avoidedTopics?: string;
    preferredExpressions?: string[];
    people?: { name: string; relation: string | null }[];
  };
}

const SCHEMA = {
  type: "object",
  properties: {
    options: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          phrase: { type: "string" },
          sensitive: { type: "boolean" },
        },
        required: ["label", "phrase", "sensitive"],
        additionalProperties: false,
      },
    },
  },
  required: ["options"],
  additionalProperties: false,
} as const;

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "sem chave Anthropic" }, { status: 503 });
  }

  const body = (await request.json()) as SuggestRequest;
  const client = new Anthropic();

  const p = body.profile;
  const perfil = p
    ? [
        p.name ? `Nome/tratamento do paciente: ${p.name}` : null,
        p.speechStyle
          ? `Jeito de falar do paciente (imitar tom e vocabulário): ${p.speechStyle}`
          : null,
        p.preferredExpressions?.length
          ? `Expressões típicas do paciente (use como referência de estilo):\n${p.preferredExpressions
              .map((e) => `- "${e}"`)
              .join("\n")}`
          : null,
        p.people?.length
          ? `Pessoas importantes: ${p.people
              .map((x) => (x.relation ? `${x.name} (${x.relation})` : x.name))
              .join(", ")}`
          : null,
        p.avoidedTopics
          ? `Temas que NÃO devem ser sugeridos: ${p.avoidedTopics}`
          : null,
      ]
        .filter(Boolean)
        .join("\n")
    : null;

  const contexto = [
    perfil ? `Perfil do paciente:\n${perfil}` : null,
    `Pergunta atual: ${body.question}`,
    `Tema: ${body.category}`,
    body.path.length > 0
      ? `Caminho da conversa até aqui:\n${body.path
          .map((p) => `- "${p.question}" → ${p.answer}`)
          .join("\n")}`
      : null,
    body.rejected.length > 0
      ? `Opções já rejeitadas pelo paciente (não repetir): ${body.rejected.join("; ")}`
      : null,
    body.draft && body.draft.length > 0
      ? `Mensagem em construção até agora: "${body.draft.join(" ")}" — sugira frases que continuem essa mensagem.`
      : null,
    "Gere até 3 novas opções.",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: contexto }],
    });

    if (response.stop_reason === "refusal") {
      return Response.json({ options: [] });
    }

    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") {
      return Response.json({ options: [] });
    }
    const parsed = JSON.parse(text.text) as {
      options: { label: string; phrase: string; sensitive: boolean }[];
    };
    return Response.json({ options: parsed.options.slice(0, 3) });
  } catch (err) {
    console.error("sugestão IA falhou:", err);
    return Response.json({ error: "falha na geração" }, { status: 502 });
  }
}
