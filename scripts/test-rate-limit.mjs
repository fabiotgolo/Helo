// ——— O limitador de taxa, provado no HTTP (Fase 5.4C — A-10) ———
//
//   npm run emu:test                                          (terminal 1)
//   npm run dev:teste                                         (terminal 2)
//   npm run test:rate:limite                                  (terminal 3)
//
// A 5.4A procurou por limitador em todo o produto e não achou nenhum. O pior
// caso era a composição de música: autenticada, mas sem teto, com até 300
// segundos de composição paga por chamada. Um laço na máquina de um cuidador
// legítimo esgotava a cota da conta.
//
// ——— Por que esta suíte é HTTP, e não de unidade ———
//
// Um limitador tem duas metades e as duas erram de formas diferentes. A
// aritmética (que janela é esta? quanto falta para virar?) erra em silêncio. A
// CONCORRÊNCIA erra do jeito que importa: duas requisições simultâneas leem
// "faltam 1" e ambas passam, e o teto vira sugestão. Só o segundo tipo de erro
// custa dinheiro, e ele não aparece num teste que chama a função uma vez por
// linha. Por isso a prova central aqui dispara vinte pedidos ao mesmo tempo
// contra o servidor de verdade, com o Firestore de verdade no meio.
//
// ——— O que esta suíte NÃO faz ———
//
// Não espera o relógio. As janelas são de um minuto, cinco minutos e uma hora,
// e um teste que dorme uma hora não é rodado por ninguém. A virada de janela é
// provada de outro jeito, no §8: a suíte SEMEIA um balde cheio na janela
// anterior e mostra que ele não conta e que ele é apagado.
//
// Não chama a ElevenLabs. O endpoint escolhido para a prova de contagem é
// `/api/helo/conversation-token`, e o limitador roda ANTES da conferência da
// chave do provedor — com o servidor de teste sem chave, os pedidos abaixo do
// teto recebem 503 "não configurado" sem tocar em ninguém, e o pedido acima do
// teto recebe 429. É a diferença entre os dois status que está sob teste.

import { readFileSync } from "node:fs";
import { assertEmuladorDescartavel } from "./emulator-guard.mjs";

const BASE = process.argv[2] ?? "http://localhost:3510";
const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "helo-db";

assertEmuladorDescartavel(EMU, DB, "test-rate-limit.mjs");

let passed = 0;
let failed = 0;
function check(nome, cond, detalhe = "") {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${nome}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${nome} ${detalhe}`);
  }
}
function secao(titulo) {
  console.log(`\n${titulo}`);
}

const fonte = (caminho) => readFileSync(new URL(`../${caminho}`, import.meta.url), "utf8");

/**
 * A fonte sem os comentários.
 *
 * A 5.4B já tropeçou três vezes nisto e deixou registrado: uma asserção que
 * procura um identificador na fonte crua encontra a MENÇÃO a ele numa nota
 * explicando por que ele não é usado. Esta suíte nasceu com o mesmo defeito —
 * "nenhuma das duas usa increment" reprovava por causa do comentário que
 * explica por que `FieldValue.increment` foi descartado.
 */
function semComentarios(texto) {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((linha) => linha.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

function cliente() {
  let cookie = "";
  return {
    async req(method, path, body) {
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = r.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      return r;
    },
    async post(path, body) {
      const r = await this.req("POST", path, body);
      let json = null;
      try {
        json = await r.json();
      } catch {}
      return { status: r.status, json, headers: r.headers };
    },
  };
}

const REST = `http://${EMU}/v1/projects/${PROJECT}/databases/${DB}/documents`;
const AUTORIZADO = { Authorization: "Bearer owner", "Content-Type": "application/json" };

/** Os baldes que existem agora, como {id: contagem}. */
async function baldes() {
  const r = await fetch(`${REST}/rateLimits?pageSize=300`, { headers: AUTORIZADO });
  if (!r.ok) return {};
  const dados = await r.json();
  const saida = {};
  for (const doc of dados.documents ?? []) {
    const id = doc.name.split("/").pop();
    saida[id] = {
      contagem: Number(doc.fields?.contagem?.integerValue ?? 0),
      expiraEm: doc.fields?.expiraEm?.timestampValue ?? null,
      campos: Object.keys(doc.fields ?? {}),
    };
  }
  return saida;
}

async function main() {
  console.log(`base: ${BASE} · emulador: ${EMU} (db ${DB})\n`);

  // ════════════════════════════════════════════════════════════════════
  secao("0. Os dois gêmeos concordam");
  //
  // O limitador existe duas vezes: `lib/rate-limit.ts` para o app Next e uma
  // cópia em `functions/index.js` para as Cloud Functions, que não
  // compartilham código com ele. É a mesma duplicação de `patientAccess` e de
  // `midia-privada`, e ela tem o mesmo risco: os dois lados divergirem sem
  // ninguém notar. Aqui a divergência quebra o teste.
  {
    const ts = fonte("lib/rate-limit.ts");
    const js = fonte("functions/index.js");

    // A tabela do lado das Functions é executada de verdade, não relida: o
    // texto é extraído e avaliado, então o que responde é a implementação.
    const tabelaJs = js.match(/const LIMITES = \{[\s\S]*?\n\};/);
    check("a tabela de limites das Functions foi encontrada", Boolean(tabelaJs));
    const LIMITES_JS = tabelaJs ? new Function(`${tabelaJs[0]}\nreturn LIMITES;`)() : {};

    const idDoBaldeJs = js.match(/function idDoBalde\(endpoint, userId, patientId, agoraMs\) \{[\s\S]*?\n\}/);
    check("o construtor de chave das Functions foi encontrado", Boolean(idDoBaldeJs));
    const construirJs = idDoBaldeJs
      ? new Function(`${tabelaJs[0]}\n${idDoBaldeJs[0]}\nreturn idDoBalde;`)()
      : null;

    for (const [nome, esperado] of Object.entries(LIMITES_JS)) {
      const bloco = ts.match(new RegExp(`\\n  ${nome}: \\{[^}]*\\}`));
      check(`\`${nome}\` existe também no lado TypeScript`, Boolean(bloco));
      if (!bloco) continue;
      check(
        `…com o mesmo limite (${esperado.limite})`,
        new RegExp(`limite: ${esperado.limite}\\b`).test(bloco[0]),
        `— ${bloco[0].trim()}`
      );
      check(
        `…com a mesma unidade (${esperado.unidade})`,
        bloco[0].includes(`unidade: "${esperado.unidade}"`),
        `— ${bloco[0].trim()}`
      );
      check(
        `…e com a mesma decisão em falha (falhaFechada: ${esperado.falhaFechada})`,
        bloco[0].includes(`falhaFechada: ${esperado.falhaFechada}`),
        `— ${bloco[0].trim()}`
      );
    }

    // A unidade `usuarioEPaciente` não é alcançável por HTTP — ela só existe
    // nos dois endpoints das Cloud Functions. Aqui ela é exercitada de
    // verdade, executando o construtor real.
    if (construirJs) {
      const comPaciente = construirJs("fraseAudio", "abc123", 7, 3_600_000);
      const semPaciente = construirJs("musica", "abc123", 7, 3_600_000);
      check(
        "a frase separa por paciente — o paciente entra na chave",
        comPaciente === "fraseAudio__abc123__7__1",
        `— ${comPaciente}`
      );
      check(
        "a música NÃO separa por paciente — quem paga é a conta",
        semPaciente === "musica__abc123__-__1",
        `— ${semPaciente}`
      );
      check(
        "dois pacientes do mesmo cuidador não dividem o balde da frase",
        construirJs("fraseAudio", "abc123", 8, 3_600_000) !== comPaciente
      );
      check(
        "dois pacientes do mesmo cuidador DIVIDEM o balde da música",
        construirJs("musica", "abc123", 8, 3_600_000) === semPaciente
      );
    }

    check(
      "as duas cópias usam a mesma coleção",
      ts.includes('COLECAO_DE_LIMITES = "rateLimits"') &&
        js.includes('COLECAO_DE_LIMITES = "rateLimits"')
    );
    check(
      "as duas contam dentro de uma transação",
      /runTransaction/.test(ts) && /runTransaction/.test(js)
    );
    check(
      "nenhuma das duas usa increment sem ler o valor novo",
      !/increment/.test(semComentarios(ts)) && !/increment/.test(semComentarios(js))
    );
    check(
      "as duas devolvem o VEREDITO da transação, não a contagem crua",
      /excedeu: true/.test(ts) && /excedeu: true/.test(js),
      "— devolver o número torna 'gastei a última vaga' e 'já estava cheio' iguais"
    );
  }

  // ════════════════════════════════════════════════════════════════════
  secao("1. A coleção do limitador é inalcançável pelo cliente");
  {
    // O escopo é explícito: dado de rate limit não pode ser lido nem escrito
    // pelo navegador. No Helo isso já vale por construção — o cliente não fala
    // com o Firestore —, e é o arquivo de regras que sustenta a afirmação.
    const regras = fonte("firestore.rules");
    check(
      "firestore.rules nega tudo ao cliente, inclusive rateLimits",
      /match \/\{document=\*\*\} \{\s*\n\s*allow read, write: if false;/.test(regras)
    );
    check(
      "e não existe exceção aberta em lugar nenhum do arquivo",
      !/allow (read|write|read, write):\s*if true/.test(regras)
    );
  }

  const wipe = await fetch(`${REST}`, { method: "DELETE" }).catch(() => null);
  void wipe;
  const limpou = await fetch(
    `http://${EMU}/emulator/v1/projects/${PROJECT}/databases/${DB}/documents`,
    { method: "DELETE" }
  );
  if (!limpou.ok) {
    console.error("não consegui limpar o emulador — abortando");
    process.exit(1);
  }

  const admin = cliente();
  await admin.post("/api/auth/bootstrap", {
    name: "Admin",
    email: "admin@helo.test",
    password: "senha-admin-123",
  });
  const paciente = (await admin.post("/api/patients", { name: "Paciente" })).json;
  const pacienteId = paciente.id ?? paciente.patient?.id;

  const TODAS = [
    "createSession", "editRoutine", "editEmergency", "editConversation",
    "viewActivities", "createActivities", "editActivities", "deleteActivities",
    "editProfile", "editGestures", "viewMetrics",
  ];

  async function criarCuidador(nome, email) {
    const c = cliente();
    const r = await admin.post("/api/admin/users", {
      name: nome, email, password: "senha-teste-123", role: "profissional",
      professionalType: "fonoaudiologo",
    });
    await c.post("/api/auth/login", { email, password: "senha-teste-123" });
    await admin.post("/api/admin/access", {
      userId: r.json.user.id, patientId: pacienteId, permissions: TODAS,
    });
    return { cliente: c, usuario: r.json.user };
  }

  const a = await criarCuidador("Cuidadora A", "a@helo.test");
  const b = await criarCuidador("Cuidadora B", "b@helo.test");

  // O endpoint da prova. O limitador roda depois do vínculo e ANTES da
  // conferência da chave do provedor — sem chave, o permitido é 503.
  const pedirToken = (c) => c.post("/api/helo/conversation-token", { patientId: pacienteId });
  const LIMITE_DA_CONVERSA = 12;

  // ════════════════════════════════════════════════════════════════════
  secao("2. Abaixo do teto passa; acima, 429");
  {
    const respostas = [];
    for (let i = 0; i < LIMITE_DA_CONVERSA + 2; i += 1) {
      respostas.push(await pedirToken(a.cliente));
    }
    const passaram = respostas.filter((r) => r.status !== 429);
    const barradas = respostas.filter((r) => r.status === 429);
    check(
      `os primeiros ${LIMITE_DA_CONVERSA} pedidos passam pelo limitador`,
      passaram.length === LIMITE_DA_CONVERSA,
      `— passaram ${passaram.length}`
    );
    check(
      "e nenhum deles é 429",
      respostas.slice(0, LIMITE_DA_CONVERSA).every((r) => r.status !== 429)
    );
    check(
      "o 13º recebe 429",
      respostas[LIMITE_DA_CONVERSA]?.status === 429,
      `— ${respostas[LIMITE_DA_CONVERSA]?.status}`
    );
    check("e o 14º também", barradas.length === 2, `— ${barradas.length} barrados`);
    check(
      "os que passaram pararam no provedor ausente, não no limitador",
      passaram.every((r) => r.status === 503),
      `— status: ${[...new Set(passaram.map((r) => r.status))].join(",")}`
    );

    const recusa = respostas[LIMITE_DA_CONVERSA];
    check(
      "a recusa traz Retry-After",
      Boolean(recusa?.headers.get("retry-after")),
      "— ausente"
    );
    const espera = Number(recusa?.headers.get("retry-after"));
    check(
      "…com valor coerente com a janela real (1..300s)",
      Number.isInteger(espera) && espera >= 1 && espera <= 300,
      `— ${espera}`
    );
    check(
      "…e a recusa não pode ser guardada",
      recusa?.headers.get("cache-control") === "no-store",
      `— ${recusa?.headers.get("cache-control")}`
    );

    // ——— O corpo do 429 não conta nada de dentro ———
    const corpo = JSON.stringify(recusa?.json ?? {});
    check("a recusa não devolve o contador interno", !/\d+\s*\/\s*\d+|contagem|usadas/.test(corpo));
    check("nem o limite configurado", !new RegExp(`\\b${LIMITE_DA_CONVERSA}\\b`).test(corpo));
    check("nem o patientId", !corpo.includes(String(pacienteId)));
    check("nem o e-mail de quem pediu", !corpo.includes("@"));
    check("nem caminho de Firestore", !/rateLimits|documents|projects\//.test(corpo));
    check("nem cota do provedor", !/elevenlabs|quota|credit/i.test(corpo));
    check(
      "ela diz só o que quem espera precisa saber",
      recusa?.json?.reason === "rate_limited",
      `— ${corpo}`
    );
  }

  // ════════════════════════════════════════════════════════════════════
  secao("3. Um usuário no teto não derruba o outro");
  {
    const outra = await pedirToken(b.cliente);
    check(
      "a cuidadora B passa mesmo com a A esgotada",
      outra.status !== 429,
      `— ${outra.status}`
    );
  }

  // ════════════════════════════════════════════════════════════════════
  secao("4. Endpoints não dividem o mesmo balde");
  {
    // A cuidadora A está no teto da conversa. O grant é outro endpoint, com
    // outro teto — e um balde compartilhado faria este pedido morrer junto.
    const grant = await a.cliente.post("/api/voice/grant", {
      patientId: pacienteId,
      // Origem de forma válida mas inexistente: o interesse aqui é passar
      // pelo limitador, não resolver a frase.
      source: { kind: "favoritePhrase", phraseId: "inexistente" },
    });
    check(
      "o grant não é 429 com a conversa esgotada",
      grant.status !== 429,
      `— ${grant.status}`
    );
  }

  // ════════════════════════════════════════════════════════════════════
  secao("5. A chave é opaca — nada de pessoa entra nela");
  {
    const atuais = await baldes();
    const ids = Object.keys(atuais);
    check("existe balde gravado", ids.length > 0, `— ${ids.length}`);
    check("nenhuma chave contém e-mail", ids.every((id) => !id.includes("@")));
    check(
      "nenhuma chave contém o nome de quem pediu",
      ids.every((id) => !/cuidadora|admin|paciente/i.test(id))
    );
    check(
      "toda chave é endpoint__usuário__paciente__janela, só com caracteres seguros",
      ids.every((id) => /^[a-zA-Z]+__[A-Za-z0-9_-]+__(-|\d+)__\d+$/.test(id)),
      `— ${ids[0]}`
    );
    // O balde DA CUIDADORA A, nomeado. `find(startsWith("conversa__"))`
    // escolhia um qualquer, e a essa altura já existem vários — o da B (§3)
    // tem contagem 1. A ordem da listagem não é garantida, então a asserção
    // "parou no teto" reprovava uma vez a cada três ou quatro execuções sem
    // nada ter mudado no produto. Um seletor ambíguo não é flake: é uma
    // pergunta mal feita.
    const daConversa = ids.find(
      (id) => id.startsWith("conversa__") && id.includes(a.usuario.id)
    );
    check("o balde da conversa da cuidadora A existe", Boolean(daConversa), `— ${ids.join(", ")}`);
    if (daConversa) {
      const janela = Number(daConversa.split("__").pop());
      const esperada = Math.floor(Date.now() / (5 * 60_000));
      check(
        "a janela na chave é a janela real do relógio",
        Math.abs(janela - esperada) <= 1,
        `— chave ${janela}, relógio ${esperada}`
      );
      check(
        "o balde da conversa não separa por paciente",
        daConversa.split("__")[2] === "-",
        `— ${daConversa}`
      );
      const doc = atuais[daConversa];
      check(
        "o balde parou de contar no teto e não passou dele",
        doc.contagem === LIMITE_DA_CONVERSA,
        `— ${doc.contagem}`
      );
      check("o balde guarda expiraEm, para a política de TTL", Boolean(doc.expiraEm));
      check(
        "…e a expiração está no futuro",
        doc.expiraEm ? new Date(doc.expiraEm).getTime() > Date.now() : false,
        `— ${doc.expiraEm}`
      );
      check(
        "o balde guarda SÓ contagem e expiração — nada de quem, nada de quê",
        doc.campos.sort().join(",") === "contagem,expiraEm",
        `— ${doc.campos.join(",")}`
      );
    }
  }

  // ════════════════════════════════════════════════════════════════════
  secao("6. Concorrência — vinte ao mesmo tempo não furam o teto");
  {
    // A prova que justifica a transação. Sem ela, requisições simultâneas leem
    // a mesma contagem e todas passam: o teto vira sugestão exatamente quando
    // alguém tem motivo para atacá-lo.
    const c = await criarCuidador("Cuidadora C", "c@helo.test");
    const disparos = Array.from({ length: 20 }, () => pedirToken(c.cliente));
    const respostas = await Promise.all(disparos);
    const passaram = respostas.filter((r) => r.status !== 429).length;
    check(
      `exatamente ${LIMITE_DA_CONVERSA} passam entre 20 simultâneos`,
      passaram === LIMITE_DA_CONVERSA,
      `— passaram ${passaram}`
    );
    check(
      "os outros 8 recebem 429",
      respostas.filter((r) => r.status === 429).length === 20 - LIMITE_DA_CONVERSA
    );

    const atuais = await baldes();
    const daVez = Object.entries(atuais).find(
      ([id, doc]) => id.startsWith("conversa__") && doc.contagem === LIMITE_DA_CONVERSA && id.includes(c.usuario.id)
    );
    check(
      "e o contador no banco parou exatamente no teto",
      Boolean(daVez),
      `— ${JSON.stringify(atuais)}`
    );
  }

  // ════════════════════════════════════════════════════════════════════
  secao("7. A janela vira — o balde anterior não conta, e some");
  {
    // Sem dormir cinco minutos: a suíte SEMEIA um balde cheio na janela
    // ANTERIOR do mesmo usuário e mostra as duas coisas de uma vez — que ele
    // não é contado (o pedido passa) e que o primeiro pedido da janela nova o
    // apaga.
    const d = await criarCuidador("Cuidadora D", "d@helo.test");
    const janelaAtual = Math.floor(Date.now() / (5 * 60_000));
    const idAnterior = `conversa__${d.usuario.id}__-__${janelaAtual - 1}`;
    const semeado = await fetch(`${REST}/rateLimits/${idAnterior}`, {
      method: "PATCH",
      headers: AUTORIZADO,
      body: JSON.stringify({
        fields: {
          contagem: { integerValue: "999" },
          expiraEm: { timestampValue: new Date(Date.now() - 60_000).toISOString() },
        },
      }),
    });
    check("o balde da janela anterior foi semeado", semeado.ok, `— ${semeado.status}`);

    const r = await pedirToken(d.cliente);
    check(
      "um balde estourado na janela anterior não barra a janela atual",
      r.status !== 429,
      `— ${r.status}`
    );

    const atuais = await baldes();
    check(
      "…e o primeiro pedido da janela nova apagou o balde velho",
      !(idAnterior in atuais),
      `— ainda existe: ${JSON.stringify(atuais[idAnterior] ?? null)}`
    );
    check(
      "…tendo criado o balde da janela atual com contagem 1",
      atuais[`conversa__${d.usuario.id}__-__${janelaAtual}`]?.contagem === 1,
      `— ${JSON.stringify(atuais[`conversa__${d.usuario.id}__-__${janelaAtual}`] ?? null)}`
    );
  }

  // ════════════════════════════════════════════════════════════════════
  secao("8. O anônimo nem chega ao limitador");
  {
    // A ordem do escopo: autenticação e autorização primeiro. Quem não
    // autenticou recebe 401 — nunca 429 —, e assim o limite não vira um canal
    // que conta a um desconhecido quanto alguém andou usando o sistema.
    const anonimo = cliente();
    const r = await anonimo.post("/api/helo/conversation-token", { patientId: pacienteId });
    check("sem sessão, a resposta é 401", r.status === 401, `— ${r.status}`);
    check("e nunca 429", r.status !== 429);

    const antes = Object.keys(await baldes()).length;
    for (let i = 0; i < 5; i += 1) await anonimo.post("/api/helo/conversation-token", { patientId: pacienteId });
    const depois = Object.keys(await baldes()).length;
    check("um anônimo insistente não cria balde nenhum", depois === antes, `— ${antes} → ${depois}`);
  }

  console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((erro) => {
  console.error(erro);
  process.exit(1);
});
