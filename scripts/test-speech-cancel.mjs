// ——— A fala antiga nunca vence a nova; a 503 não é para sempre ———
//
//   npm run test:voice:cancel
//
// Roda o CÓDIGO DE PRODUÇÃO: `buscaAudioDaFala` (lib/voice/speech-audio-source.ts)
// e `DisponibilidadeElevenLabs` (lib/voice/eleven-availability.ts) — as mesmas
// funções que lib/useSpeech.ts executa a cada fala. Simulado é só o que está
// fora do app: `fetch`, o Blob e `URL.createObjectURL`.
//
// Os dois defeitos que esta suíte existe para impedir de voltar:
//
//   R-06/§5  Uma resposta atrasada chegava depois do stop(), criava um
//            ObjectURL e tocava por cima da fala nova. Numa Rotina isso
//            significa a resposta de UMA pergunta soando durante a seguinte.
//
//   R-11     Uma 503 de dez segundos desligava a voz — da Helo e do paciente —
//            pelo resto da vida da aba. Só recarregar a página trazia de volta.
//
// A ordem dos eventos é controlada à mão (promessas que resolvemos quando
// queremos), porque o que está sendo provado É a ordem.

import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const { buscaAudioDaFala } = await import("../lib/voice/speech-audio-source.ts");
const { AudioCache } = await import("../lib/voice/audio-cache.ts");
const { DisponibilidadeElevenLabs, ehFalhaTransitoria, COOLDOWN_MS } = await import(
  "../lib/voice/eleven-availability.ts"
);
const { audioCacheKey } = await import("../lib/voice.ts");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

/** Promessa que este teste resolve na hora que quiser. */
function comporta() {
  let abre;
  const espera = new Promise((resolve) => {
    abre = resolve;
  });
  return { espera, abre };
}

function respostaDeAudio(voiceSource = "heloElevenLabs") {
  return {
    ok: true,
    status: 200,
    headers: { get: (nome) => (nome === "X-Voice-Source" ? voiceSource : null) },
    blob: async () => ({ tipo: "audio/mpeg" }),
  };
}

function respostaDeErro(status) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({ error: "recusado" }),
    blob: async () => ({}),
  };
}

function respostaDeGrant(text, grant = "hg1.x.y") {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ grant, text }),
  };
}

/** Ambiente de uma chamada: cache real, disponibilidade real, rede simulada. */
function ambiente({ agora, cooldownMs } = {}) {
  const revogados = [];
  const criados = [];
  const cache = new AudioCache({ revoke: (url) => revogados.push(url) });
  const disponibilidade = new DisponibilidadeElevenLabs({ agora, cooldownMs });
  const chamadas = [];
  let contador = 0;
  return {
    cache,
    disponibilidade,
    revogados,
    criados,
    chamadas,
    deps(fetchImpl) {
      return {
        cache,
        disponibilidade,
        fetchImpl: (url, init) => {
          chamadas.push({ url, init, signal: init?.signal });
          return fetchImpl(url, init);
        },
        criaObjectURL: () => {
          const url = `blob:helo/${++contador}`;
          criados.push(url);
          return url;
        },
        log: () => {},
      };
    },
  };
}

const pedidoDaPlataforma = (text, extra = {}) => ({
  text,
  speakerRole: "helo",
  confirmationStatus: "notRequired",
  patientId: null,
  aindaVale: () => true,
  ...extra,
});

console.log("\n— 1. stop ANTES da resposta HTTP —");
{
  const amb = ambiente();
  const porta = comporta();
  let valida = true;
  const promessa = buscaAudioDaFala(
    pedidoDaPlataforma("bom dia", { aindaVale: () => valida }),
    amb.deps(async () => {
      await porta.espera;
      return respostaDeAudio();
    })
  );
  // O stop() acontece enquanto a requisição ainda está no ar.
  valida = false;
  porta.abre();
  const r = await promessa;
  check("a fala interrompida não devolve áudio", r.ok === false && r.motivo === "cancelada");
  check(
    "o áudio que chegou atrasado ficou no cache, não órfão",
    amb.cache.get(audioCacheKey("helo", null, "bom dia")) !== undefined,
    "— tem dono e será revogado na hora certa"
  );
  check("e nenhum URL foi revogado às pressas", amb.revogados.length === 0);
}

console.log("\n— 2. abort derruba a requisição de verdade —");
{
  const amb = ambiente();
  const controle = new AbortController();
  let abortada = false;
  const promessa = buscaAudioDaFala(
    pedidoDaPlataforma("bom dia", { signal: controle.signal, aindaVale: () => !controle.signal.aborted }),
    amb.deps(
      (url, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => {
            abortada = true;
            const erro = new Error("abortado");
            erro.name = "AbortError";
            reject(erro);
          });
        })
    )
  );
  controle.abort();
  const r = await promessa;
  check("o sinal chega ao fetch", abortada, "— sem isso o servidor segue sintetizando o que ninguém vai ouvir");
  check("abortar é cancelamento, não falha", r.ok === false && r.motivo === "cancelada");
  check(
    "e NÃO marca a ElevenLabs como indisponível",
    amb.disponibilidade.estado !== "degradado",
    "— um stop() não pode derrubar a voz da aba inteira"
  );
}

console.log("\n— 3. o cancelamento economiza a chamada de síntese —");
{
  // Interromper durante a AUTORIZAÇÃO deve impedir o /api/tts. É onde o
  // cancelamento vale dinheiro: a síntese é a parte paga.
  const amb = ambiente();
  const porta = comporta();
  let valida = true;
  const promessa = buscaAudioDaFala(
    {
      text: "quero água",
      speakerRole: "patient",
      confirmationStatus: "confirmed",
      patientId: 7,
      source: { kind: "favoritePhrase", phraseId: "p1" },
      aindaVale: () => valida,
    },
    amb.deps(async (url) => {
      if (url === "/api/voice/grant") {
        await porta.espera;
        return respostaDeGrant("SIM, quero um copo d'água.");
      }
      return respostaDeAudio("patientElevenLabsClone");
    })
  );
  valida = false;
  porta.abre();
  const r = await promessa;
  check("devolve cancelada", r.ok === false && r.motivo === "cancelada");
  check(
    "e /api/tts NUNCA foi chamado",
    !amb.chamadas.some((c) => c.url === "/api/tts"),
    `— chamadas: ${amb.chamadas.map((c) => c.url).join(", ")}`
  );
  check("nenhum ObjectURL foi criado", amb.criados.length === 0);
}

console.log("\n— 4. a resposta antiga chega DEPOIS da nova —");
{
  // O caso que produz a falha visível: duas falas em voo, a primeira mais
  // lenta. Se a antiga vencer, o paciente ouve a resposta da pergunta
  // anterior durante a pergunta seguinte.
  const amb = ambiente();
  const portaAntiga = comporta();
  let geracao = 1;

  const antiga = buscaAudioDaFala(
    pedidoDaPlataforma("pergunta um", { aindaVale: () => geracao === 1 }),
    amb.deps(async () => {
      await portaAntiga.espera;
      return respostaDeAudio();
    })
  );

  // A fala nova começa e termina primeiro.
  geracao = 2;
  const nova = await buscaAudioDaFala(
    pedidoDaPlataforma("pergunta dois", { aindaVale: () => geracao === 2 }),
    amb.deps(async () => respostaDeAudio())
  );
  check("a fala nova é atendida", nova.ok === true);

  // Só agora a antiga responde.
  portaAntiga.abre();
  const r = await antiga;
  check(
    "a fala antiga não vence",
    r.ok === false && r.motivo === "cancelada",
    "— era ela tocando por cima da nova"
  );
  check(
    "as duas ficaram no cache (nenhuma virou lixo)",
    amb.cache.get(audioCacheKey("helo", null, "pergunta um")) !== undefined &&
      amb.cache.get(audioCacheKey("helo", null, "pergunta dois")) !== undefined
  );
}

console.log("\n— 5. nova fala imediatamente depois funciona —");
{
  const amb = ambiente();
  let geracao = 1;
  const primeira = await buscaAudioDaFala(
    pedidoDaPlataforma("um", { aindaVale: () => geracao === 1 }),
    amb.deps(async () => respostaDeAudio())
  );
  geracao = 2; // stop()
  const segunda = await buscaAudioDaFala(
    pedidoDaPlataforma("dois", { aindaVale: () => geracao === 2 }),
    amb.deps(async () => respostaDeAudio())
  );
  check("a primeira foi atendida", primeira.ok === true);
  check("a segunda também", segunda.ok === true);
  check("com áudios distintos", primeira.ok && segunda.ok && primeira.entrada.url !== segunda.entrada.url);
}

console.log("\n— 6. o cache evita o round-trip do grant —");
{
  const amb = ambiente();
  const pedido = {
    text: "preciso de ajuda",
    speakerRole: "patient",
    confirmationStatus: "notRequired",
    patientId: 7,
    source: { kind: "emergencyItem", defaultKey: "emergencia.ajuda" },
    aindaVale: () => true,
  };
  const deps = amb.deps(async (url) =>
    url === "/api/voice/grant"
      ? respostaDeGrant("preciso de ajuda")
      : respostaDeAudio("patientElevenLabsClone")
  );
  const primeira = await buscaAudioDaFala(pedido, deps);
  const chamadasApos = amb.chamadas.length;
  const segunda = await buscaAudioDaFala(pedido, deps);
  check("a primeira sintetizou", primeira.ok === true && primeira.doCache === false);
  check("a segunda veio do cache", segunda.ok === true && segunda.doCache === true);
  check(
    "sem nenhuma chamada de rede",
    amb.chamadas.length === chamadasApos,
    "— a Emergência não pode pagar um round-trip a cada toque"
  );
}

console.log("\n— 7. o texto que vale é o do servidor —");
{
  const amb = ambiente();
  const r = await buscaAudioDaFala(
    {
      text: "quero água",
      speakerRole: "patient",
      confirmationStatus: "confirmed",
      patientId: 7,
      source: { kind: "favoritePhrase", phraseId: "p1" },
      aindaVale: () => true,
    },
    amb.deps(async (url, init) => {
      if (url === "/api/voice/grant") return respostaDeGrant("SIM, quero um copo d'água.");
      const corpo = JSON.parse(init.body);
      check("o TTS recebe o texto do GRANT, não o da tela", corpo.text === "SIM, quero um copo d'água.");
      check("e o grant vai junto", corpo.grant === "hg1.x.y");
      return respostaDeAudio("patientElevenLabsClone");
    })
  );
  check("a fala é atendida", r.ok === true);
  check(
    "o áudio é encontrável pelos dois textos",
    amb.cache.get(audioCacheKey("patient", 7, "quero água")) !== undefined &&
      amb.cache.get(audioCacheKey("patient", 7, "SIM, quero um copo d'água.")) !== undefined
  );
}

console.log("\n— 8. grant negado não é indisponibilidade da ElevenLabs —");
{
  const amb = ambiente();
  const r = await buscaAudioDaFala(
    {
      text: "quero água",
      speakerRole: "patient",
      confirmationStatus: "confirmed",
      patientId: 7,
      source: { kind: "favoritePhrase", phraseId: "p1" },
      aindaVale: () => true,
    },
    amb.deps(async (url) => (url === "/api/voice/grant" ? respostaDeErro(403) : respostaDeAudio()))
  );
  check("a fala é recusada", r.ok === false && r.motivo === "semAutorizacao");
  check("e /api/tts nem é chamado", !amb.chamadas.some((c) => c.url === "/api/tts"));
  check(
    "a ElevenLabs continua disponível",
    amb.disponibilidade.estado !== "degradado",
    "— um grant negado diz que o PEDIDO não vale, não que o provedor caiu"
  );
}

console.log("\n— 9. fala do paciente sem origem nem grant não sai —");
{
  const amb = ambiente();
  const r = await buscaAudioDaFala(
    {
      text: "qualquer coisa",
      speakerRole: "patient",
      confirmationStatus: "confirmed",
      patientId: 7,
      aindaVale: () => true,
    },
    amb.deps(async () => respostaDeAudio())
  );
  check("bloqueada por falta de autorização", r.ok === false && r.motivo === "semAutorizacao");
  check("nenhuma chamada de rede aconteceu", amb.chamadas.length === 0);
}

// ————————————————————————————————————————————————————————————————
console.log("\n— 10. R-11: o que conta como indisponibilidade —");
{
  check("503 conta", ehFalhaTransitoria(503));
  check("502 conta", ehFalhaTransitoria(502));
  check("504 conta", ehFalhaTransitoria(504));
  check("erro de rede conta", ehFalhaTransitoria(null));
  check("401 NÃO conta", !ehFalhaTransitoria(401));
  check("403 NÃO conta", !ehFalhaTransitoria(403), "— é o SpeechGrant funcionando");
  check("422 NÃO conta", !ehFalhaTransitoria(422));
  check("400 NÃO conta", !ehFalhaTransitoria(400));
}

console.log("\n— 11. R-11: 503 abre prazo, não desliga a voz —");
{
  let relogio = 1_000_000;
  const amb = ambiente({ agora: () => relogio, cooldownMs: 30_000 });
  const deps503 = amb.deps(async () => respostaDeErro(503));

  const primeira = await buscaAudioDaFala(pedidoDaPlataforma("um"), deps503);
  check("a fala falha", primeira.ok === false && primeira.motivo === "indisponivel");
  check("o estado vira degradado", amb.disponibilidade.estado === "degradado");

  const chamadasApos = amb.chamadas.length;
  const durante = await buscaAudioDaFala(pedidoDaPlataforma("dois"), deps503);
  check("dentro do prazo, nem tenta", durante.ok === false && durante.motivo === "indisponivel");
  check(
    "nenhuma chamada nova sai durante o prazo",
    amb.chamadas.length === chamadasApos,
    "— é isso que evita a rajada contra um provedor já em dificuldade"
  );
  check("o prazo é informado", amb.disponibilidade.esperaRestanteMs === 30_000);

  // Passa o tempo.
  relogio += 30_001;
  check("passado o prazo, volta a permitir tentativa", amb.disponibilidade.podeTentar());
  const depois = await buscaAudioDaFala(
    pedidoDaPlataforma("três"),
    amb.deps(async () => respostaDeAudio())
  );
  check("e a tentativa seguinte funciona", depois.ok === true);
  check("o sucesso restaura a disponibilidade", amb.disponibilidade.estado === "disponivel");
  check("sem prazo pendente", amb.disponibilidade.esperaRestanteMs === 0);
}

console.log("\n— 12. R-11: nada tenta sozinho —");
{
  // "Não criar polling contínuo": a recuperação é carona numa ação que já ia
  // acontecer. Passado o prazo, ZERO chamadas até alguém pedir uma fala.
  let relogio = 0;
  const amb = ambiente({ agora: () => relogio, cooldownMs: 1000 });
  await buscaAudioDaFala(pedidoDaPlataforma("um"), amb.deps(async () => respostaDeErro(503)));
  const chamadas = amb.chamadas.length;
  relogio += 60_000; // uma eternidade
  await new Promise((r) => setTimeout(r, 20));
  check(
    "o tempo passa e nenhuma chamada é feita por conta própria",
    amb.chamadas.length === chamadas
  );
  check("mas a próxima fala passa", amb.disponibilidade.podeTentar());
}

console.log("\n— 13. R-11: uma falha nova reabre o prazo —");
{
  let relogio = 0;
  const amb = ambiente({ agora: () => relogio, cooldownMs: 1000 });
  await buscaAudioDaFala(pedidoDaPlataforma("um"), amb.deps(async () => respostaDeErro(503)));
  relogio += 1001;
  await buscaAudioDaFala(pedidoDaPlataforma("dois"), amb.deps(async () => respostaDeErro(503)));
  check("segue degradado", amb.disponibilidade.estado === "degradado");
  check("com prazo renovado", amb.disponibilidade.esperaRestanteMs === 1000);
  check("e a tentativa seguinte é bloqueada de novo", !amb.disponibilidade.podeTentar());
}

console.log("\n— 14. R-11: 403 não abre prazo nenhum —");
{
  const amb = ambiente();
  const r = await buscaAudioDaFala(
    pedidoDaPlataforma("um"),
    amb.deps(async () => respostaDeErro(403))
  );
  check("a fala falha", r.ok === false && r.motivo === "falhou");
  check("mas o estado NÃO degrada", amb.disponibilidade.estado !== "degradado");
  check(
    "e a fala seguinte tenta normalmente",
    amb.disponibilidade.podeTentar(),
    "— desligar a voz da aba por causa de uma autorização recusada seria diagnóstico falso"
  );
}

console.log("\n— 15. R-11: falha de rede também é temporária —");
{
  let relogio = 0;
  const amb = ambiente({ agora: () => relogio, cooldownMs: 5000 });
  const r = await buscaAudioDaFala(
    pedidoDaPlataforma("um"),
    amb.deps(async () => {
      throw new TypeError("Failed to fetch");
    })
  );
  check("a fala falha", r.ok === false && r.motivo === "falhou");
  check("o estado vira degradado", amb.disponibilidade.estado === "degradado");
  relogio += 5001;
  const depois = await buscaAudioDaFala(
    pedidoDaPlataforma("dois"),
    amb.deps(async () => respostaDeAudio())
  );
  check("e a rede voltando, a voz volta", depois.ok === true);
  check("sem recarregar a página", amb.disponibilidade.estado === "disponivel");
}

console.log("\n— 16. o prazo padrão é curto o bastante para não parecer quebrado —");
{
  check(
    "COOLDOWN_MS está entre 10s e 2min",
    COOLDOWN_MS >= 10_000 && COOLDOWN_MS <= 120_000,
    `— ${COOLDOWN_MS}ms`
  );
  const amb = ambiente();
  amb.disponibilidade.registraFalha(503);
  check("e o estado é reiniciável (logout)", (() => {
    amb.disponibilidade.reinicia();
    return amb.disponibilidade.estado === "desconhecido" && amb.disponibilidade.podeTentar();
  })());
}

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
