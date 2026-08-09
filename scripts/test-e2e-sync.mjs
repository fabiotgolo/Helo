// ——— A sincronização da criação de sessão é pelo request, não pelo relógio ———
//
// O helper `iniciarNovaSessao` existe porque esperar só o heading da tela
// seguinte punha compilação sob demanda, POST, emulador e renderização dentro
// do mesmo orçamento de 10s de um `expect` visual. Duas propriedades dele são
// fáceis de quebrar sem ninguém perceber, e nenhuma suíte de interface as
// pegaria (o teste continuaria passando numa máquina ociosa):
//
//   1. a espera precisa ser REGISTRADA ANTES do clique. Depois é corrida: a
//      resposta pode chegar antes de a espera existir.
//   2. a espera precisa ser por ESTE request — método e caminho —, e não por
//      "a rede ficou quieta".
//
// Por isso a conferência aqui é do texto do helper: é a única forma de provar
// ordem e ausência. Todo comentário é removido antes de qualquer busca — este
// arquivo fala de `networkidle` e `waitForTimeout` em prosa, e já tropeçamos
// nessa armadilha três vezes neste projeto.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let ok = 0;
let mau = 0;

function checa(nome, condicao) {
  if (condicao) {
    ok += 1;
    console.log(`  ✓ ${nome}`);
  } else {
    mau += 1;
    console.log(`  ✗ ${nome}`);
  }
}

/** Sem comentários: só o código executável entra nas buscas. */
function codigoDe(caminho) {
  return readFileSync(resolve(RAIZ, caminho), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const helpers = codigoDe("tests/e2e/helpers.ts");
const oc = codigoDe("tests/e2e/option-conversation-helpers.ts");

const corpo =
  helpers.match(
    /export async function iniciarNovaSessao[\s\S]*?\n\}/
  )?.[0] ?? "";

console.log("\niniciarNovaSessao: a espera existe e cerca a ação certa");
checa("o helper existe", corpo.length > 0);
checa("espera por uma resposta, não por tempo", corpo.includes("waitForResponse"));
checa(
  "clica em «Iniciar nova sessão»",
  /getByRole\("button", \{ name: "Iniciar nova sessão" \} \)?/.test(
    corpo.replace(/\s+/g, " ")
  ) || corpo.includes('name: "Iniciar nova sessão"')
);

console.log("\nfronteira 1: a hidratação é aguardada antes de tudo");
const posHidratacao = corpo.search(/toBeEnabled\(\)/);
checa(
  "espera o botão HABILITADO, sinal que só existe depois da hidratação",
  posHidratacao > -1
);
checa(
  "o sinal vem da própria tela, sem instrumentar o produto",
  !corpo.includes("data-helo-hydrated") && !corpo.includes("__react") && !corpo.includes("__next")
);

console.log("\nfronteira 2: registrar a espera ANTES da ação que dispara o request");
const posEspera = corpo.indexOf("waitForResponse");
const posClique = corpo.indexOf(".click(");
const posAwait = corpo.search(/await\s+resposta\b|await\s+\w+;\s*$/m);
checa("a hidratação é aguardada antes de registrar a espera", posHidratacao < posEspera);
checa("waitForResponse aparece antes do clique", posEspera > -1 && posEspera < posClique);
checa("a promessa não é aguardada na mesma linha em que nasce", !/await\s+page\.waitForResponse/.test(corpo));
checa("a resposta só é aguardada depois do clique", posAwait > posClique);

console.log("\num clique, e um só — nunca repetir por não ter vindo o POST");
checa("existe exatamente um .click() no helper", (corpo.match(/\.click\(/g) ?? []).length === 1);
checa("não há laço de repetição", !/\b(for|while)\b/.test(corpo));
checa("não há captura que engula a falha para tentar de novo", !/catch/.test(corpo));

console.log("\nidentificação do request: método e caminho exato");
checa("exige POST", /method\(\)\s*!==\s*"POST"|method\(\)\s*===\s*"POST"/.test(corpo));
checa("compara o pathname, não a URL inteira", corpo.includes("pathname"));
checa(
  "usa a rota de criação de sessão",
  helpers.includes('ROTA_CRIAR_SESSAO = "/api/realtime-questions/sessions"') &&
    corpo.includes("ROTA_CRIAR_SESSAO")
);
checa(
  "não casa por substring solta da URL",
  !/url\(\)\.includes\(/.test(corpo)
);

console.log("\nresposta não-ok falha ANTES do expect visual");
checa("confere r.ok()", /\.ok\(\)/.test(corpo));
checa("a mensagem de erro traz o status", /status\(\)/.test(corpo));
checa(
  "a mensagem não despeja o corpo da resposta",
  !/\.text\(\)|\.json\(\)|\.body\(\)/.test(corpo)
);
checa(
  "o helper termina na conferência da resposta, sem verificar tela",
  !corpo.includes("toBeVisible")
);

console.log("\nnenhuma espera temporal artificial foi introduzida");
for (const proibido of [
  "networkidle",
  "waitForTimeout",
  "waitForLoadState",
  "setTimeout",
]) {
  checa(`iniciarNovaSessao não usa ${proibido}`, !corpo.includes(proibido));
}
checa(
  "helpers.ts inteiro segue sem networkidle",
  !helpers.includes("networkidle")
);
checa(
  "helpers.ts inteiro segue sem waitForTimeout",
  !helpers.includes("waitForTimeout")
);

console.log("\no expect visual continua existindo, e depois");
const pular =
  helpers.match(/export async function pularContexto[\s\S]*?\n\}/)?.[0] ?? "";
checa("pularContexto ainda confere o heading", pular.includes("toBeVisible"));
checa(
  "e ainda é o heading do contexto",
  pular.includes("Contexto da conversa (opcional)")
);
checa(
  "pularContexto não ganhou espera de rede",
  !pular.includes("waitForResponse") && !pular.includes("networkidle")
);

console.log("\na conversa por opções passa pelo helper sincronizado");
checa("importa iniciarNovaSessao", oc.includes("iniciarNovaSessao"));
checa("chama iniciarNovaSessao", oc.includes("await iniciarNovaSessao(page)"));
checa(
  "não clica mais no botão sem sincronizar",
  !oc.includes('name: "Iniciar nova sessão"')
);
const ordemOc = [
  oc.indexOf("iniciarNovaSessao(page)"),
  oc.indexOf("pularContexto(page)"),
];
checa("sincroniza antes de pular o contexto", ordemOc[0] > -1 && ordemOc[0] < ordemOc[1]);

console.log(
  `\n${mau === 0 ? "✓" : "✗"} ${ok} passaram, ${mau} falharam`
);
process.exit(mau === 0 ? 0 : 1);
