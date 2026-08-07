// ——— Pressão de armazenamento e teto da fila (R10 e R13) ———
//
// Puro. O que este arquivo protege é a ORDEM DE PRIORIDADE: sob pressão, o
// snapshot é sacrificável e a fila não é. Errar isso para o lado errado
// apagaria intenção clínica que ninguém mais tem — e o faria em silêncio,
// justamente no momento em que ninguém está olhando.
//
//   npm run test:offline:armazenamento

import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const {
  AVISO_DA_FILA,
  DESCARTAVEIS_SOB_PRESSAO,
  FRACAO_DE_PRESSAO,
  OfflineStorageFullError,
  TETO_DA_FILA,
  decidirEnfileiramento,
  ehErroDeCota,
  fraseDoArmazenamento,
  haPressaoDeCota,
  ocupacaoDaFila,
} = await import("@/lib/offline/armazenamento");

let passou = 0;
let falhou = 0;
function ok(cond, nome) {
  if (cond) {
    passou += 1;
    console.log(`  ✓ ${nome}`);
  } else {
    falhou += 1;
    console.log(`  ✗ ${nome}`);
  }
}
function eq(a, b, nome) {
  ok(a === b, `${nome}${a === b ? "" : ` — esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`}`);
}
function secao(t) {
  console.log(`\n${t}`);
}

const filaCom = (n, status = "PENDING") =>
  Array.from({ length: n }, () => ({ status }));

// ════════════════════════════════════════════════════════════════════
secao("1. storage.estimate() DISPONÍVEL");
{
  const cota = 1000;
  ok(
    !haPressaoDeCota({ disponivel: true, usadoBytes: 500, cotaBytes: cota }),
    "metade da cota não é pressão"
  );
  ok(
    haPressaoDeCota({ disponivel: true, usadoBytes: 900, cotaBytes: cota }),
    `${FRACAO_DE_PRESSAO * 100}% da cota é pressão`
  );
  ok(
    haPressaoDeCota({ disponivel: true, usadoBytes: 999, cotaBytes: cota }),
    "quase cheio é pressão"
  );
  ok(
    !haPressaoDeCota({ disponivel: true, usadoBytes: 889, cotaBytes: cota }),
    "logo abaixo do limiar ainda não é"
  );
}

secao("2. storage.estimate() INDISPONÍVEL — nunca assume o pior");
{
  // A regra que evita transformar uma proteção em perda de função: um
  // navegador sem a API pode ter espaço de sobra, e bloquear preventivamente
  // tiraria o modo offline de quem talvez mais precisasse dele.
  ok(
    !haPressaoDeCota({ disponivel: false, usadoBytes: null, cotaBytes: null }),
    "sem a API, NÃO há pressão presumida"
  );
  ok(
    !haPressaoDeCota({ disponivel: true, usadoBytes: null, cotaBytes: null }),
    "API presente mas sem números também não presume nada"
  );
  ok(
    !haPressaoDeCota({ disponivel: true, usadoBytes: 100, cotaBytes: 0 }),
    "cota zero (absurda) não vira divisão por zero nem pressão"
  );
}

secao("3. Aproximação do limite");
{
  const antes = decidirEnfileiramento(filaCom(AVISO_DA_FILA - 5));
  eq(antes.kind, "ACEITA", "bem abaixo do aviso, aceita em silêncio");

  const noLimiar = decidirEnfileiramento(filaCom(AVISO_DA_FILA - 1));
  eq(noLimiar.kind, "ACEITA_COM_AVISO", "a operação que ATINGE o limiar já avisa");
  eq(noLimiar.pendentes, AVISO_DA_FILA, "e diz quantas são");

  const depois = decidirEnfileiramento(filaCom(AVISO_DA_FILA + 50));
  eq(depois.kind, "ACEITA_COM_AVISO", "acima do limiar continua avisando");
  ok(
    depois.kind !== "RECUSADA",
    "avisar NÃO é recusar — entre o aviso e o teto a conversa continua"
  );
}

secao("4. Teto atingido");
{
  const cheia = decidirEnfileiramento(filaCom(TETO_DA_FILA));
  eq(cheia.kind, "RECUSADA", "no teto, recusa");
  eq(cheia.teto, TETO_DA_FILA, "e informa qual é o teto");

  const acima = decidirEnfileiramento(filaCom(TETO_DA_FILA + 10));
  eq(acima.kind, "RECUSADA", "acima do teto continua recusando");

  const ultima = decidirEnfileiramento(filaCom(TETO_DA_FILA - 1));
  ok(ultima.kind !== "RECUSADA", "a última vaga ainda é aceita");
}

secao("5. SYNCED não ocupa a fila");
{
  // Contar o que o servidor já aceitou faria o teto chegar mais cedo por
  // causa de trabalho que já terminou — e o cuidador seria barrado por uma
  // conversa que, na prática, já foi inteira registrada.
  eq(ocupacaoDaFila(filaCom(10, "SYNCED")), 0, "SYNCED não conta");
  eq(ocupacaoDaFila(filaCom(3, "PENDING")), 3, "PENDING conta");
  eq(ocupacaoDaFila(filaCom(2, "CONFLICT")), 2, "CONFLICT conta — ainda está aqui");
  eq(ocupacaoDaFila(filaCom(2, "FAILED")), 2, "FAILED conta");
  eq(
    decidirEnfileiramento([...filaCom(TETO_DA_FILA, "SYNCED"), ...filaCom(1)]).kind,
    "ACEITA",
    "uma fila inteira de SYNCED não bloqueia nada"
  );
}

secao("6. QuotaExceededError é reconhecido em todos os dialetos");
{
  ok(ehErroDeCota({ name: "QuotaExceededError" }), "o nome padrão");
  ok(ehErroDeCota({ name: "NS_ERROR_DOM_QUOTA_REACHED" }), "o dialeto do Firefox");
  ok(ehErroDeCota({ code: 22 }), "o código legado (Safari)");
  ok(!ehErroDeCota({ name: "AbortError" }), "outro erro de IndexedDB NÃO é cota");
  ok(!ehErroDeCota(null), "nulo não explode");
  ok(!ehErroDeCota("QuotaExceededError"), "string não conta — só erro de verdade");
}

secao("7. O que pode ser descartado sob pressão — a lista é FECHADA");
{
  eq(DESCARTAVEIS_SOB_PRESSAO.length, 1, "uma coisa só");
  eq(DESCARTAVEIS_SOB_PRESSAO[0], "snapshots", "e é o snapshot");
  // As três garantias que o R10 exige por escrito.
  ok(!DESCARTAVEIS_SOB_PRESSAO.includes("operacoes"), "operações NUNCA são descartáveis");
  ok(!DESCARTAVEIS_SOB_PRESSAO.includes("rascunhos"), "rascunhos NUNCA são descartáveis");
  ok(!DESCARTAVEIS_SOB_PRESSAO.includes("chaves"), "a chave de cifra NUNCA é descartável");
}

secao("8. A frase que o cuidador lê");
{
  eq(
    fraseDoArmazenamento({ degradado: false, perto: false, cheia: false, pendentes: 3, teto: TETO_DA_FILA }),
    null,
    "tudo bem: silêncio, e não uma faixa dizendo que está tudo bem"
  );

  const degradado = fraseDoArmazenamento({
    degradado: true, perto: false, cheia: false, pendentes: 3, teto: TETO_DA_FILA,
  });
  ok(/recuperação visual/i.test(degradado), "degradação: nomeia o que foi reduzido");
  ok(
    /nenhum registro pendente foi apagado/i.test(degradado),
    "E diz o que NÃO se perdeu — sem isso, o cuidador teria motivo para achar que perdeu registro"
  );

  const perto = fraseDoArmazenamento({
    degradado: false, perto: true, cheia: false, pendentes: 210, teto: 500,
  });
  ok(/210/.test(perto) && /500/.test(perto), "aviso: diz onde está e qual é o limite");
  ok(/recupere a conexão/i.test(perto), "e orienta a recuperar conexão");

  const cheia = fraseDoArmazenamento({
    degradado: false, perto: true, cheia: true, pendentes: 500, teto: 500,
  });
  ok(/não consegue guardar mais/i.test(cheia), "teto: diz que parou");
  ok(/recupere a conexão/i.test(cheia), "e o que fazer para destravar");
  // Prioridade: a mais grave primeiro.
  ok(
    cheia !== perto,
    "fila cheia não é anunciada com a frase de 'perto do limite'"
  );
  const tudoJunto = fraseDoArmazenamento({
    degradado: true, perto: true, cheia: true, pendentes: 500, teto: 500,
  });
  ok(
    /não consegue guardar mais/i.test(tudoJunto),
    "com tudo acontecendo, a fila cheia é o que aparece — anunciar a menor esconderia a maior"
  );
}

secao("9. OfflineStorageFullError carrega o que a tela precisa");
{
  const e = new OfflineStorageFullError(500, 500);
  eq(e.name, "OfflineStorageFullError", "tem nome próprio");
  eq(e.pendentes, 500, "sabe quantas há");
  eq(e.teto, 500, "e qual é o teto");
  ok(e instanceof Error, "é um Error de verdade — quem chamou é obrigado a tratar");
}

secao("10. Os valores são coerentes entre si");
{
  ok(AVISO_DA_FILA < TETO_DA_FILA, "o aviso vem ANTES do teto");
  ok(AVISO_DA_FILA > 0 && TETO_DA_FILA > 0, "ambos positivos");
  ok(
    FRACAO_DE_PRESSAO > 0 && FRACAO_DE_PRESSAO < 1,
    "a fração de pressão é uma fração"
  );
  // Uma folga real entre avisar e barrar: sem ela, o aviso não teria como
  // ser útil — o cuidador leria e já estaria travado.
  ok(
    TETO_DA_FILA - AVISO_DA_FILA >= 100,
    `há folga entre avisar (${AVISO_DA_FILA}) e barrar (${TETO_DA_FILA})`
  );
}

// ════════════════════════════════════════════════════════════════════
console.log(`\n${passou} passou, ${falhou} falhou.`);
process.exit(falhou === 0 ? 0 : 1);
