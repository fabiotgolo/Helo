// ——— Todo ObjectURL tem dono e ponto de liberação (R-06) ———
//
//   npm run test:audio:cache
//
// A suíte roda o CÓDIGO DE PRODUÇÃO: `AudioCache`, de lib/voice/audio-cache.ts,
// exatamente a classe que lib/useSpeech.ts instancia. O que é simulado é só o
// navegador — `URL.revokeObjectURL` vira uma função que ANOTA cada liberação.
//
// Essa anotação é o teste inteiro. Um vazamento de ObjectURL não lança erro,
// não aparece no console e não quebra nada visível: o Blob simplesmente fica
// na memória da aba até ela fechar. A única forma de provar que ele foi solto
// é observar a chamada. A única forma de provar que ele NÃO foi solto cedo
// demais é observar que ela não aconteceu.

import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const { AudioCache, LIMITE_PADRAO } = await import("../lib/voice/audio-cache.ts");
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

/** Um cache com o navegador simulado: `revogados` é o registro de liberações. */
function novoCache(limite) {
  const revogados = [];
  const cache = new AudioCache({ limite, revoke: (url) => revogados.push(url) });
  return { cache, revogados };
}

let contador = 0;
function entrada(source = "heloElevenLabs") {
  return { url: `blob:helo/${++contador}`, source };
}

const chaveHelo = (texto) => audioCacheKey("helo", null, texto);
const chavePaciente = (id, texto) => audioCacheKey("patient", id, texto);

console.log("\n— O básico: guardar e reencontrar —");
{
  const { cache, revogados } = novoCache();
  const a = entrada();
  cache.set(chaveHelo("bom dia"), a);
  check("uma entrada guardada é encontrada", cache.get(chaveHelo("bom dia"))?.url === a.url);
  check("um texto que não foi guardado não é encontrado", cache.get(chaveHelo("boa noite")) === undefined);
  check("guardar não revoga nada", revogados.length === 0);
  check(
    "áudio da plataforma não responde por uma fala do paciente com o mesmo texto",
    cache.get(chavePaciente(7, "bom dia")) === undefined
  );
}

console.log("\n— Substituir uma chave libera o áudio anterior —");
{
  const { cache, revogados } = novoCache();
  const velha = entrada();
  const nova = entrada();
  cache.set(chaveHelo("bom dia"), velha);
  cache.set(chaveHelo("bom dia"), nova);
  check("o URL substituído é revogado", revogados.length === 1 && revogados[0] === velha.url);
  check("o novo continua acessível", cache.get(chaveHelo("bom dia"))?.url === nova.url);
  check("e não sobra entrada duplicada", cache.tamanho === 1);
}

console.log("\n— Despejo por limite (LRU) —");
{
  const { cache, revogados } = novoCache(3);
  const e1 = entrada();
  const e2 = entrada();
  const e3 = entrada();
  const e4 = entrada();
  cache.set(chaveHelo("um"), e1);
  cache.set(chaveHelo("dois"), e2);
  cache.set(chaveHelo("três"), e3);
  check("no limite, nada é despejado", revogados.length === 0 && cache.tamanho === 3);

  // Usar "um" o torna o mais recente: quem deve sair passa a ser "dois".
  cache.get(chaveHelo("um"));
  cache.set(chaveHelo("quatro"), e4);
  check("o excedente despeja a entrada usada há mais tempo", revogados.length === 1 && revogados[0] === e2.url);
  check("o acerto de cache renova a entrada (não foi ela que saiu)", cache.get(chaveHelo("um"))?.url === e1.url);
  check("o despejo revoga, não só remove", revogados.includes(e2.url));
  check("o tamanho volta ao limite", cache.tamanho === 3);
}

console.log("\n— O áudio que está tocando não é despejado —");
{
  const { cache, revogados } = novoCache(2);
  const tocando = entrada();
  cache.set(chaveHelo("tocando"), tocando);
  cache.fixa(chaveHelo("tocando"));
  cache.set(chaveHelo("outra"), entrada());
  cache.set(chaveHelo("mais outra"), entrada());
  check(
    "a entrada fixada sobrevive ao despejo",
    cache.get(chaveHelo("tocando"))?.url === tocando.url,
    "— revogar o URL de um áudio em reprodução o cortaria no meio"
  );
  check("o URL fixado não foi revogado", !revogados.includes(tocando.url));
  check("outra entrada saiu no lugar dela", revogados.length === 1);

  // Terminou de tocar: volta a ser candidata. Duas inserções, porque o `get`
  // acima a renovou — ela é a mais RECENTE agora, e só sai depois da outra.
  cache.fixa(null);
  check("a fixação foi solta", cache.chaveFixada === null);
  cache.set(chaveHelo("terceira"), entrada());
  cache.set(chaveHelo("quarta"), entrada());
  check(
    "solta a fixação, ela volta a ser despejável",
    revogados.includes(tocando.url),
    "— a proteção é da reprodução, não permanente"
  );
}

console.log("\n— Um cache só de entradas fixadas não perde a que toca —");
{
  // Caso de borda do laço de despejo: se TUDO está acima do limite e a única
  // candidata é a fixada, o cache passa do limite em vez de cortar o áudio no
  // meio. É a escolha certa — o excesso é transitório e sai na fala seguinte.
  const { cache, revogados } = novoCache(1);
  const tocando = entrada();
  cache.set(chaveHelo("tocando"), tocando);
  cache.fixa(chaveHelo("tocando"));
  cache.set(chaveHelo("nova"), entrada());
  check(
    "prefere passar do limite a revogar o áudio em reprodução",
    cache.get(chaveHelo("tocando"))?.url === tocando.url && !revogados.includes(tocando.url)
  );
}

console.log("\n— Duas chaves para o mesmo áudio (o servidor mandou outro texto) —");
{
  // Quando o grant devolve um texto diferente do que a tela pediu, a MESMA
  // entrada é indexada sob as duas chaves. Revogar na saída da primeira
  // deixaria a segunda apontando para um URL morto: o cache acertaria e o
  // áudio não tocaria — a pior falha possível, porque é silenciosa.
  const { cache, revogados } = novoCache();
  const compartilhada = entrada();
  cache.set(chavePaciente(7, "quero água"), compartilhada);
  cache.set(chavePaciente(7, "SIM, quero um copo d'água."), compartilhada);
  check("as duas chaves encontram o mesmo áudio", cache.tamanho === 2);

  cache.remove(chavePaciente(7, "quero água"));
  check(
    "sair a primeira chave NÃO revoga — a outra ainda alcança o URL",
    revogados.length === 0
  );
  check(
    "e a segunda continua servindo o áudio",
    cache.get(chavePaciente(7, "SIM, quero um copo d'água."))?.url === compartilhada.url
  );

  cache.remove(chavePaciente(7, "SIM, quero um copo d'água."));
  check("saída da última chave revoga", revogados.length === 1 && revogados[0] === compartilhada.url);
}

console.log("\n— Troca de paciente: sai o áudio dele, fica o da plataforma —");
{
  const { cache, revogados } = novoCache();
  const doSete = entrada("patientElevenLabsClone");
  const doOito = entrada("patientElevenLabsClone");
  const daPlataforma = entrada();
  cache.set(chavePaciente(7, "preciso de ajuda"), doSete);
  cache.set(chavePaciente(8, "preciso de ajuda"), doOito);
  cache.set(chaveHelo("preciso de ajuda"), daPlataforma);

  const removidas = cache.purgePatient(7);
  check("remove exatamente as entradas daquele paciente", removidas === 1);
  check("e revoga o URL delas", revogados.length === 1 && revogados[0] === doSete.url);
  check("o áudio do paciente 7 sumiu", cache.get(chavePaciente(7, "preciso de ajuda")) === undefined);
  check("o do paciente 8 ficou intacto", cache.get(chavePaciente(8, "preciso de ajuda"))?.url === doOito.url);
  check(
    "o da plataforma ficou — não é de ninguém em particular",
    cache.get(chaveHelo("preciso de ajuda"))?.url === daPlataforma.url
  );

  cache.purgePatient();
  check("sem argumento, sai o áudio de TODOS os pacientes", cache.get(chavePaciente(8, "preciso de ajuda")) === undefined);
  check("e a plataforma segue ali", cache.get(chaveHelo("preciso de ajuda"))?.url === daPlataforma.url);
  check("o URL do paciente 8 também foi revogado", revogados.includes(doOito.url));
}

console.log("\n— Um paciente nunca alcança o áudio de outro —");
{
  // A defesa não é uma checagem: é a CHAVE. Mesmo texto, pacientes
  // diferentes, chaves diferentes.
  const { cache } = novoCache();
  const doSete = entrada("patientElevenLabsClone");
  cache.set(chavePaciente(7, "estou com dor"), doSete);
  check(
    "o paciente 8 não acerta o cache do paciente 7",
    cache.get(chavePaciente(8, "estou com dor")) === undefined,
    "— o mesmo texto na voz clonada da pessoa errada"
  );
  check(
    "e a plataforma também não",
    cache.get(chaveHelo("estou com dor")) === undefined
  );
}

console.log("\n— Logout e desmontagem: nada sobra —");
{
  const { cache, revogados } = novoCache();
  const urls = [];
  for (const texto of ["um", "dois", "três"]) {
    const e = entrada();
    urls.push(e.url);
    cache.set(chaveHelo(texto), e);
  }
  cache.set(chavePaciente(7, "quatro"), entrada("patientElevenLabsClone"));
  cache.fixa(chaveHelo("um")); // até o que está tocando sai no logout

  const total = cache.purgeAll();
  check("purgeAll informa quantas entradas saíram", total === 4);
  check("todos os URLs foram revogados", revogados.length === 4);
  check("o cache fica vazio", cache.tamanho === 0);
  check("a fixação é solta junto", cache.chaveFixada === null);
  check("nenhum URL ficou de fora", urls.every((url) => revogados.includes(url)));
}

console.log("\n— Nenhum URL fica órfão, em nenhum caminho —");
{
  // O invariante que resume os anteriores: ao fim de uma sequência qualquer,
  // (URLs criados) = (URLs ainda alcançáveis) + (URLs revogados). Um órfão é
  // exatamente um URL que não está em nenhum dos dois lados.
  const { cache, revogados } = novoCache(4);
  const criados = [];
  for (let i = 0; i < 30; i++) {
    const e = entrada(i % 3 === 0 ? "patientElevenLabsClone" : "heloElevenLabs");
    criados.push(e.url);
    const chave = i % 3 === 0 ? chavePaciente(7, `t${i}`) : chaveHelo(`t${i}`);
    cache.set(chave, e);
    if (i === 10) cache.fixa(chaveHelo("t10"));
    if (i === 17) cache.fixa(null);
    if (i === 20) cache.purgePatient(7);
    if (i === 25) cache.set(chaveHelo("t25"), entrada()); // substituição
  }
  const vivos = new Set(cache.chaves.map((c) => cache.get(c).url));
  cache.purgeAll();
  const orfaos = criados.filter((url) => !revogados.includes(url));
  check(
    "depois de despejo, fixação, purga e substituição, todo URL criado foi revogado",
    orfaos.length === 0,
    `— órfãos: ${orfaos.join(", ")}`
  );
  check("e o cache terminou vazio", cache.tamanho === 0, `— ${vivos.size} vivos antes do purgeAll`);
}

console.log("\n— O limite padrão é o que a política diz —");
{
  check(
    "LIMITE_PADRAO cabe o maior conjunto pré-aquecido com folga",
    LIMITE_PADRAO >= 20 && LIMITE_PADRAO <= 64,
    `— ${LIMITE_PADRAO}; ver a justificativa no cabeçalho de lib/voice/audio-cache.ts`
  );
  const { cache } = novoCache();
  for (let i = 0; i < LIMITE_PADRAO + 10; i++) cache.set(chaveHelo(`t${i}`), entrada());
  check("o cache não passa do limite padrão", cache.tamanho === LIMITE_PADRAO, `— ${cache.tamanho}`);
}

console.log("\n— Nada disso persiste no aparelho —");
{
  const fonte = await import("node:fs").then((fs) =>
    fs.readFileSync("lib/voice/audio-cache.ts", "utf8")
  );
  // Procura CHAMADAS, não palavras: o cabeçalho do arquivo cita "IndexedDB"
  // justamente para dizer que não usa, e uma busca ingênua reprovaria isso.
  check(
    "o cache não escreve em IndexedDB nem na Cache API",
    !/\b(indexedDB|caches)\.\w+\(|(local|session)Storage\.\w+\(/.test(fonte),
    "— áudio da voz clonada de um paciente não fica gravado no aparelho"
  );
}

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
