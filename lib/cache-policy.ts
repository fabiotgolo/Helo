// ——— Política de cache das respostas sensíveis (Fase 5.4C — A-10b) ———
//
// ——— O que foi medido, e não presumido ———
//
// A 5.4A leu o código e encontrou rotas sem `Cache-Control`. A 5.4C mediu: uma
// build de PRODUÇÃO do Next 16.2.10, levantada localmente, foi consultada em
// catorze rotas. **Nenhuma delas emitiu `Cache-Control`** — nem no sucesso,
// nem no 400, nem no 401. O framework não põe nada por conta própria em
// route handler; o que não está escrito na rota não existe na resposta.
//
// Isso responde a pergunta que decidia o tamanho desta correção: não há
// default a herdar. Cada resposta que não deve ser guardada precisa dizer isso.
//
// ——— Por que uma constante em vez de uma camada ———
//
// A tentação era um `proxy.ts` (o que o Next 16 passou a chamar o antigo
// `middleware.ts`) carimbando o header em `/api/:path*` de uma vez. Foi
// descartado por três motivos, nesta ordem:
//
//   1. **A própria documentação do Next desaconselha.** O guia embarcado diz,
//      textualmente, para evitar depender de Middleware/Proxy a menos que não
//      exista outra opção. Construir uma camada nova em cima de um recurso que
//      o framework está desmontando é dívida com data marcada.
//   2. **A precedência não é documentada.** Um header posto pelo Proxy — ou
//      pela configuração global de `headers()` — sobre uma rota que já define o
//      seu não tem regra escrita em lugar nenhum do guia. E a 5.4B definiu, com
//      razão, `private, max-age=0, must-revalidate` para a música: um carimbo
//      global de `no-store` por cima disso transformaria cada arrasto da barra
//      de progresso numa descida nova do arquivo inteiro. Trocar um risco de
//      privacidade por uma regressão de produto seria mau negócio.
//   3. **O escopo é explícito** sobre não alterar configuração global às cegas.
//
// O preço da escolha é honesto: uma rota nova não herda a política. Por isso a
// suíte `test:cache:politica` confere o resultado no HTTP, e não a existência
// da constante — quem esquecer o header verá o teste, não o revisor.
//
// ——— Por que `no-store` e não `private, no-store` ———
//
// `private` é redundante sob `no-store`: `no-store` já proíbe qualquer cache,
// compartilhado ou não. O escopo pede para não acrescentar header por
// superstição, e o produto já usa `no-store` puro em `/api/tts`,
// `/api/voice/grant` e `/api/voice/dictation` desde a 5.1A. Uma string só, e a
// que já estava lá.
//
// As rotas de MÍDIA são a exceção deliberada e mantêm o que a 5.4B definiu
// (`private, no-store` para a voz clonada; `private, max-age=0,
// must-revalidate` para a música). Lá o `private` não é redundante: ele
// convive com um `max-age`.

/** A política das respostas que não podem ser guardadas em lugar nenhum. */
export const SEM_ARMAZENAMENTO = "no-store";

export const CABECALHOS_SEM_ARMAZENAMENTO: Readonly<Record<string, string>> = {
  "Cache-Control": SEM_ARMAZENAMENTO,
};

/**
 * `Response.json` com a política aplicada.
 *
 * Existe para que sucesso e erro saiam pelo mesmo lugar. A 5.4A encontrou o
 * padrão contrário — o header no 200 e ausente no 401 —, e um erro também
 * carrega contexto: "sem vínculo com este paciente" numa resposta guardada por
 * um intermediário conta a alguém que aquele paciente existe.
 */
export function jsonSemCache(dados: unknown, init: ResponseInit = {}): Response {
  return Response.json(dados, {
    ...init,
    headers: { ...CABECALHOS_SEM_ARMAZENAMENTO, ...(init.headers ?? {}) },
  });
}

/**
 * Acrescenta a política a uma `Response` que já existe — o caso das guardas de
 * `lib/auth.ts`, que devolvem a recusa pronta.
 *
 * Reconstrói em vez de mutar: os headers de uma `Response` já construída são
 * imutáveis, e um `headers.set` ali lança `TypeError` em vez de falhar
 * visivelmente na revisão.
 */
export function comPoliticaSemCache(resposta: Response): Response {
  if (resposta.headers.has("Cache-Control")) return resposta;
  const headers = new Headers(resposta.headers);
  headers.set("Cache-Control", SEM_ARMAZENAMENTO);
  return new Response(resposta.body, {
    status: resposta.status,
    statusText: resposta.statusText,
    headers,
  });
}
