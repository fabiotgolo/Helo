// ——— O ciclo de vida está ligado onde precisa estar ———
//
//   npm run test:audio:lifecycle
//
// As suítes irmãs (`test:audio:cache`, `test:voice:cancel`) provam que os
// módulos se comportam. Isso não prova que o PRODUTO os usa: um cache perfeito
// que ninguém instancia libera zero bytes.
//
// Esta suíte lê o fonte e verifica as amarrações — quem instancia, quem chama,
// e em que ponto do ciclo de vida. É verificação estrutural, com as limitações
// que ela tem: prova que a chamada existe, não que ela roda. Por isso as
// outras duas existem, e por isso o Playwright cobre o caminho de ponta a
// ponta. As três juntas cobrem o que uma sozinha não cobre.
//
// O que cada verificação impede de voltar está dito em cada uma. Nenhuma delas
// está aqui por completude.

import { readFileSync } from "node:fs";

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

const useSpeech = readFileSync("lib/useSpeech.ts", "utf8");
const coordinator = readFileSync("lib/audio-coordinator.ts", "utf8");
const auth = readFileSync("lib/use-auth.ts", "utf8");
const patient = readFileSync("lib/patient.tsx", "utf8");
const provider = readFileSync("components/helo-agent-provider.tsx", "utf8");

console.log("\n— useSpeech usa os módulos testados, não uma cópia —");
{
  check(
    "instancia o AudioCache de produção",
    /from "@\/lib\/voice\/audio-cache"/.test(useSpeech) && /new AudioCache\(/.test(useSpeech)
  );
  check(
    "instancia a DisponibilidadeElevenLabs",
    /from "@\/lib\/voice\/eleven-availability"/.test(useSpeech) &&
      /new DisponibilidadeElevenLabs\(/.test(useSpeech)
  );
  check(
    "busca o áudio por buscaAudioDaFala",
    /from "@\/lib\/voice\/speech-audio-source"/.test(useSpeech) &&
      /buscaAudioDaFala\(/.test(useSpeech)
  );
  check(
    "não guarda mais o áudio num Map solto",
    !/useRef<Map<string, \{ url: string/.test(useSpeech),
    "— era esse Map, sem dono e sem limite, que vazava"
  );
  check(
    "o estado permanente de indisponibilidade sumiu",
    !/elevenAvailable/.test(useSpeech),
    "— `elevenAvailable.current = false` era o R-11 inteiro"
  );
}

console.log("\n— Criar um ObjectURL só acontece onde há dono —");
{
  check(
    "useSpeech não cria ObjectURL diretamente",
    !/URL\.createObjectURL/.test(useSpeech),
    "— quem cria é speech-audio-source, e entrega ao cache no mesmo passo"
  );
  const fonte = readFileSync("lib/voice/speech-audio-source.ts", "utf8");
  const criacoes = (fonte.match(/criaObjectURL\(/g) ?? []).length;
  check(
    "speech-audio-source cria em um único ponto",
    criacoes === 1,
    `— ${criacoes} pontos de criação; cada um precisaria da sua própria prova de liberação`
  );
  check(
    "e o resultado vai para o cache antes de qualquer retorno",
    /cache\.set\(chave, entrada\)/.test(fonte)
  );
  // Node não liga para o `this` de `fetch`; o navegador liga. Guardado numa
  // variável sem bind, `fetchImpl(...)` estoura "Illegal invocation" e TODA
  // fala do paciente morre antes de sair — com as suítes de domínio verdes,
  // porque elas rodam em Node. Quem pegou foi tests/e2e/voz-robustez.
  check(
    "o fetch guardado em variável leva o bind",
    /fetch\.bind\(/.test(fonte),
    "— sem bind, o navegador recusa com Illegal invocation e o Node não reclama"
  );
}

console.log("\n— Inventário: todo createObjectURL do cliente tem dono —");
{
  // O mesmo raciocínio do inventário de call sites da 5.1A: a lista de quem
  // cria ObjectURL era uma lista na minha cabeça, e foi por isso que três
  // telas criaram e nenhuma liberou. Aqui ela vira verificação.
  //
  // Um dono válido é uma destas três coisas:
  //   · `usePreviewAudio`  — o hook que possui áudio e URL (prévia avulsa);
  //   · `AudioCache`       — o cache do orquestrador de voz;
  //   · um `revokeObjectURL` no mesmo arquivo, quando a tela cuida do próprio.
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const fontes = (raiz, acc = []) => {
    for (const nome of readdirSync(raiz)) {
      if (nome === "node_modules" || nome.startsWith(".")) continue;
      const caminho = join(raiz, nome);
      if (statSync(caminho).isDirectory()) fontes(caminho, acc);
      else if (/\.tsx?$/.test(nome)) acc.push(caminho);
    }
    return acc;
  };
  // Sem os comentários: um arquivo que EXPLICA o ciclo de vida de um
  // ObjectURL não é um arquivo que cria um. Foi assim que o cache entrou na
  // lista na primeira versão desta verificação.
  const codigo = (arquivo) =>
    readFileSync(arquivo, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  const criadores = ["app", "components", "lib"]
    .flatMap((r) => fontes(r))
    .filter((f) => /URL\.createObjectURL|criaObjectURL\(/.test(codigo(f)));

  console.log("\n    Quem cria ObjectURL:");
  for (const arquivo of criadores) console.log(`    · ${arquivo}`);

  check(
    "o inventário encontrou os criadores",
    criadores.length > 0,
    "— o padrão de busca quebrou; o teste não prova nada assim"
  );

  const semDono = criadores.filter((arquivo) => {
    const fonte = codigo(arquivo);
    return (
      // …libera o próprio;
      !/URL\.revokeObjectURL/.test(fonte) &&
      // …delega ao player com dono;
      !/usePreviewAudio/.test(fonte) &&
      // …ou entrega ao cache, que é quem revoga (speech-audio-source).
      !/cache\.set\(/.test(fonte)
    );
  });
  check(
    "nenhum criador ficou sem ponto de liberação",
    semDono.length === 0,
    `— ${semDono.join(", ")}: o Blob fica preso na memória da aba até ela fechar`
  );

  // As telas de prévia usam o hook; nenhuma volta a escrever a sequência à mão.
  for (const tela of [
    "app/ajustes/page.tsx",
    "app/admin/page.tsx",
    "app/atividades/gerenciar/page.tsx",
  ]) {
    const fonte = readFileSync(tela, "utf8");
    check(
      `${tela} usa o player com dono`,
      /usePreviewAudio\(\)/.test(fonte) && !/URL\.createObjectURL/.test(fonte),
      "— era a sequência create/new Audio/play sem revoke, repetida nas três"
    );
  }
  check(
    "o modal de frases salvas cuida do próprio URL",
    /URL\.revokeObjectURL/.test(readFileSync("components/phrases-to-listen-modal.tsx", "utf8")),
    "— ele também toca áudio vindo do Storage, que NÃO pode ser revogado; por isso não usa o hook"
  );
}

console.log("\n— Interromper aborta a requisição —");
{
  check("stop() aborta o que está no ar", /abortRef\.current\?\.abort\(\)/.test(useSpeech));
  check(
    "a fala registra seu AbortController",
    /abortRef\.current = controle/.test(useSpeech)
  );
  check(
    "o aquecimento tem dono de cancelamento SEPARADO",
    /primeAbortRef/.test(useSpeech),
    "— com um só, o aquecimento sobrescreveria o da fala e o stop() abortaria a requisição errada"
  );
  check(
    "e o sinal chega ao módulo de busca",
    /signal: controle\.signal/.test(useSpeech)
  );
  check(
    "a geração continua invalidando falas em preparação",
    /aindaVale: \(\) => genRef\.current === gen/.test(useSpeech),
    "— o abort é uma corrida contra a rede; a invalidação é local e não pode perder"
  );
}

console.log("\n— O áudio que toca não é liberado embaixo dele —");
{
  check("a entrada em reprodução é fixada", /cache\.fixa\(audioCacheKey\(/.test(useSpeech));
  check(
    "e solta quando a fala termina",
    /cache\.fixa\(null\)/.test(useSpeech)
  );
  const soltaNoFim = /setSpeakingBoth = useCallback\([\s\S]{0,600}?cache\.fixa\(null\)/.test(useSpeech);
  check(
    "a soltura mora em setSpeakingBoth(false) — o caminho de saída de TODA fala",
    soltaNoFim,
    "— concluída, interrompida, bloqueada, erro e fallback passam por ele"
  );
}

console.log("\n— Logout libera o áudio, não só interrompe —");
{
  check(
    "o gerenciador de áudio tem um canal de liberação",
    /export function purgePlatformAudio/.test(coordinator) &&
      /export function registerPlatformAudioPurge/.test(coordinator)
  );
  check("useSpeech se registra nele", /registerPlatformAudioPurge\(liberaAudio\)/.test(useSpeech));
  check(
    "o logout chama a liberação total",
    /purgePlatformAudio\("todos"\)/.test(auth),
    "— parar apenas pausa; os Blobs seguem presos pelos ObjectURLs"
  );
  check(
    "e continua interrompendo a fala antes",
    /stopAllSpeech\(\)/.test(auth) &&
      auth.indexOf("stopAllSpeech()") < auth.indexOf('purgePlatformAudio("todos")')
  );
  check(
    "liberar tudo também zera a indisponibilidade",
    /purgeAll\(\)[\s\S]{0,400}?disponibilidade\.reinicia\(\)/.test(useSpeech),
    "— quem entra depois não herda o prazo de espera de quem saiu"
  );
}

console.log("\n— Trocar de paciente remove o áudio do anterior —");
{
  check(
    "o provider de paciente libera na troca",
    /purgePlatformAudio\("pacientes"\)/.test(patient)
  );
  check(
    "num efeito que depende do patientId",
    /purgePlatformAudio\("pacientes"\);\s*\n\s*\}, \[patientId\]\)/.test(patient),
    "— sem a dependência, roda uma vez e nunca mais"
  );
  check(
    "e useSpeech tem a defesa de baixo, independente do provider",
    /sincronizaEscopoDoPaciente/.test(useSpeech) && /cache\.purgePatient\(/.test(useSpeech),
    "— a fala funciona em camadas que podem não ter esse provider montado"
  );
  check(
    "a liberação por escopo 'pacientes' preserva o áudio da plataforma",
    /cache\.purgePatient\(\);/.test(useSpeech)
  );
  // A liberação NÃO aborta o aquecimento — e não pode. Os efeitos dos filhos
  // rodam antes dos do provider de paciente: numa troca, a tela nova já
  // começou a aquecer o áudio do paciente NOVO quando a liberação chega.
  // Abortar ali matava o aquecimento certo, e foi assim que a suíte de
  // navegador pegou o defeito — a Emergência entrava sem áudio nenhum.
  const corpoLibera = useSpeech.match(/const liberaAudio = useCallback\([\s\S]*?\n {2}\);/)?.[0] ?? "";
  check(
    "a liberação não aborta o aquecimento em curso",
    corpoLibera.length > 0 && !/primeAbortRef/.test(corpoLibera),
    "— abortaria o aquecimento do paciente NOVO, não o do anterior"
  );
  check(
    "quem recolhe o aquecimento obsoleto é o próprio prime",
    /patientId !== activePatientId\(\)\) \{\s*\n\s*cache\.purgePatient\(patientId\);/.test(useSpeech),
    "— ele confere o paciente ativo a cada volta e limpa o que guardou fora de contexto"
  );
  check(
    "a definição INICIAL do paciente não dispara liberação",
    /if \(anterior == null \|\| anterior === patientId\) return;/.test(patient),
    "— liberaria justamente o áudio que a tela acabou de pré-aquecer"
  );
}

console.log("\n— Desmontagem definitiva não deixa nada —");
{
  const teardown = useSpeech.match(/return \(\) => \{\s*\n\s*stop\(\);[\s\S]{0,1400}?\n {4}\};/)?.[0] ?? "";
  check("existe um teardown de desmontagem", teardown.length > 0);
  check("ele para a fala", /stop\(\)/.test(teardown));
  check("aborta o aquecimento", /primeAbortRef\.current\?\.abort\(\)/.test(teardown));
  check("libera TODOS os ObjectURLs", /cache\.purgeAll\(\)/.test(teardown));
  check("fecha o AudioContext", /ctx\.close\(\)/.test(teardown));
  check(
    "e zera as refs do par elemento+contexto",
    /audioCtxRef\.current = null/.test(teardown) && /analyserRef\.current = null/.test(teardown),
    "— createMediaElementSource é irrevogável; uma remontagem precisa reconstruir do zero"
  );
  check("cancela o timer de suspensão", /clearTimeout\(suspensaoRef\.current\)/.test(teardown));
}

console.log("\n— AudioContext: suspenso no ocioso, retomado antes de falar —");
{
  check("há suspensão por ociosidade", /suspendeQuandoOcioso/.test(useSpeech));
  check("que só suspende se nada estiver tocando", /if \(speakingRef\.current\) return;/.test(useSpeech));
  check(
    "o caminho de volta já existia e continua",
    /audioCtxRef\.current\.resume\(\)/.test(useSpeech),
    "— o resume é aguardado antes do play(); suspender não cria caminho de falha novo"
  );
  check(
    "e uma fala nova cancela a suspensão pendente",
    /clearTimeout\(suspensaoRef\.current\); \/\/ vai falar/.test(useSpeech)
  );
}

console.log("\n— Nenhum estado de fala fica preso —");
{
  const finallyDaFala = useSpeech.match(/\} finally \{[\s\S]{0,900}?genRef\.current === gen[\s\S]{0,300}?\}/)?.[0] ?? "";
  check("a fala tem um finally", finallyDaFala.length > 0);
  check(
    "que desliga o speaking",
    /setSpeakingBoth\(false\)/.test(finallyDaFala),
    "— roda em TODOS os caminhos de saída, inclusive exceção"
  );
  check(
    "e setSpeakingBoth(false) zera speaker, voiceSource e a fixação juntos",
    /setActiveSpeaker\("none"\)[\s\S]{0,500}?setActiveVoiceSource\("none"\)[\s\S]{0,500}?cache\.fixa\(null\)/.test(
      useSpeech
    ),
    "— um estado zerado pela metade é pior que nenhum"
  );
  check(
    "a amplitude volta ao neutro sozinha",
    /if \(!speakingRef\.current\) return 0;/.test(useSpeech)
  );
  check(
    "stop() é idempotente: incrementa a geração antes de tudo",
    /const stop = useCallback\(\(\) => \{\s*\n\s*genRef\.current\+\+;/.test(useSpeech)
  );
}

console.log("\n— O laço de medição do Agente não roda sem sessão (R-13) —");
{
  const medicao = provider.match(/useEffect\(\(\) => \{\s*\n\s*if \(status === "disconnected"\) return;[\s\S]*?\}, \[status, getInputVolume/)?.[0] ?? "";
  check(
    "o laço só começa com sessão",
    medicao.length > 0,
    "— rodava a 60 quadros por segundo em toda tela, medindo áudio que não existia"
  );
  check("cancela o quadro pendente ao sair", /cancelAnimationFrame\(frame\)/.test(medicao));
  check(
    "o efeito depende do status",
    /\}, \[status, getInputVolume, getOutputByteFrequencyData, setAgentAmplitude\]\)/.test(provider),
    "— é a dependência que garante um único laço vivo por vez"
  );
  check(
    "e devolve o palco à voz da plataforma ao encerrar",
    /setAgentAmplitude\(null\)/.test(medicao),
    "— zero congelaria o orbe mudo durante toda fala da plataforma"
  );
  check("o medidor de microfone também zera", /setMicLevel\(0\)/.test(medicao));
}

console.log("\n— Os invariantes de autoria da 5.1A seguem de pé —");
{
  const fonte = readFileSync("lib/voice/speech-audio-source.ts", "utf8");
  check(
    "a voz do paciente ainda exige origem ou grant",
    /if \(!pedido\.source \|\| patientId == null\)[\s\S]{0,200}?motivo: "semAutorizacao"/.test(fonte)
  );
  check(
    "o texto sintetizado é o do grant",
    /speechText = autorizada\.text/.test(fonte),
    "— o cliente nunca escolhe o que a voz do paciente diz"
  );
  check(
    "a chave de cache continua separando papel e paciente",
    /audioCacheKey\(speakerRole, patientId, text\)/.test(fonte)
  );
  // As duas verificações abaixo olham o CÓDIGO, não o texto do arquivo. Uma
  // busca por "grant" ou "IndexedDB" no fonte inteiro encontraria justamente o
  // comentário que explica por que eles não estão lá — e reprovaria a
  // documentação correta.
  const cacheFonte = readFileSync("lib/voice/audio-cache.ts", "utf8");
  const camposDaEntrada = cacheFonte
    .match(/export interface AudioCacheEntry \{([\s\S]*?)\}/)?.[1]
    ?.match(/^\s*(\w+):/gm)
    ?.map((linha) => linha.trim().replace(":", "")) ?? [];
  check(
    "a entrada de cache guarda só url e voiceSource",
    camposDaEntrada.length === 2 &&
      camposDaEntrada.includes("url") &&
      camposDaEntrada.includes("source"),
    `— campos: ${camposDaEntrada.join(", ")}; nenhum grant ou token acompanha o áudio`
  );
  check(
    "e nada do áudio é persistido no aparelho",
    !/\b(indexedDB|caches)\.\w+\(|(local|session)Storage\.\w+\(/.test(cacheFonte),
    "— a voz clonada de um paciente não fica gravada no dispositivo"
  );
}

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
