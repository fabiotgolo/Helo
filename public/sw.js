// ——— App shell da sessão manual (Fase 4.9.2) ———
//
// JavaScript puro, servido de /sw.js. Ele existe por um motivo único e
// estreito: sem ele, recarregar a página com a rede fora não carrega NADA — o
// navegador não tem de onde tirar o HTML, e todo o armazenamento local que a
// Fase 4.9 monta fica inalcançável exatamente no momento em que serviria.
//
// ——— O QUE ELE NÃO É ———
//
// Não é um PWA. Não há manifest, não há prompt de instalação, não há push, não
// há sincronização em segundo plano, não há ícone na tela inicial. Ele também
// não é registrado no app inteiro: quem o instala é a tela de Perguntas em
// tempo real, e só ela. Quem nunca abriu o modo não tem Service Worker algum.
//
// ——— O QUE ELE NUNCA GUARDA ———
//
//   • /api/** — nenhuma, em nenhuma circunstância. Uma resposta de API
//     guardada seria dado clínico servido como se fosse atual, e servir dado
//     velho como atual é pior do que não servir nada;
//   • qualquer requisição que não seja GET;
//   • qualquer coisa de outra origem (ElevenLabs, fontes externas);
//   • payloads RSC (`?_rsc=`), que carregam estado de servidor.
//
// Sobra o que é estático e público por natureza: os pedaços do próprio
// aplicativo (`/_next/static/**`, com nome derivado do conteúdo) e o HTML
// pré-renderizado da tela da sessão, que não contém dado de usuário nenhum.
//
// ——— VERSÃO E INVALIDAÇÃO ———
//
// O nome do cache vem do `?v=` com que a página registra este arquivo. Versão
// nova ⇒ URL nova ⇒ o navegador trata como um Service Worker novo ⇒ instala,
// e o cache antigo é apagado na ativação. Não há build step: a versão viaja na
// própria URL do script.
//
// ——— ATUALIZAÇÃO SEGURA ———
//
// `skipWaiting` acontece SOMENTE na primeira instalação, quando não há ninguém
// para trocar o chão debaixo. Numa atualização, o Worker novo espera todas as
// abas do escopo fecharem. Trocar os pedaços do aplicativo por baixo de uma
// conversa em andamento é o tipo de coisa que quebra uma sessão à beira do
// leito, e ganhar alguns minutos não vale isso.
//
// A fila de operações vive no IndexedDB e este arquivo NÃO a toca — nem para
// ler. Uma troca de Service Worker, portanto, não tem como perder intenção
// nenhuma do cuidador.

const PREFIXO = "helo-shell-";
const VERSAO = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE = PREFIXO + VERSAO;

/**
 * As telas que precisam abrir sem rede. Só a sessão manual — é o escopo da
 * Fase 4.9. O login fica de fora de propósito: entrar exige servidor, e um
 * login servido do cache prometeria algo que não pode cumprir.
 */
const ROTAS_DO_SHELL = ["/conversa/perguntas"];

function ehRotaDoShell(pathname) {
  const limpo = pathname.replace(/\/+$/, "") || "/";
  return ROTAS_DO_SHELL.includes(limpo);
}

/**
 * Arquivos públicos que a própria moldura da tela pede.
 *
 * A lista é curta e fechada de propósito — "somente o necessário para abrir a
 * interface da sessão". Ela existe porque sem eles o offline não fica só feio:
 * o rodapé tenta buscar os dois logos repetidamente, e a enxurrada de
 * requisições falhando atrapalha a página que deveria estar funcionando.
 */
const ASSETS_PUBLICOS = [
  "/elevenlabs-logo-black.svg",
  "/elevenlabs-logo-white.svg",
  "/faviconHelo.png",
];

function ehAssetDoApp(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    ASSETS_PUBLICOS.includes(url.pathname)
  );
}

// ---------- Instalação ----------

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Falhar aqui não pode impedir a instalação: sem rede no momento do
      // registro, o Worker ainda serve para as próximas visitas.
      await Promise.all(
        [...ROTAS_DO_SHELL, ...ASSETS_PUBLICOS].map((rota) =>
          cache.add(new Request(rota, { credentials: "same-origin" })).catch(() => {})
        )
      );
      // Primeira instalação: não existe Worker anterior, então assumir agora
      // não interrompe ninguém.
      if (!self.registration.active) await self.skipWaiting();
    })()
  );
});

// ---------- Ativação ----------

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Invalidação por versão: some tudo que não é o cache desta versão.
      const nomes = await caches.keys();
      await Promise.all(
        nomes
          .filter((n) => n.startsWith(PREFIXO) && n !== CACHE)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

// ---------- Precarga dirigida pela página ----------
//
// A página sabe exatamente de quais pedaços ela precisa — eles estão nos
// `<script src>` e `<link href>` do próprio documento. Ela manda a lista, e
// assim UMA visita com rede basta para a visita seguinte funcionar sem ela.
// Descobrir isso aqui dentro seria adivinhar nomes com hash.

self.addEventListener("message", (event) => {
  const dados = event.data;
  if (!dados || dados.tipo !== "precarregar-shell") return;
  const urls = Array.isArray(dados.urls) ? dados.urls : [];

  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        urls
          .filter((u) => {
            try {
              const url = new URL(u, self.location.origin);
              return (
                url.origin === self.location.origin &&
                (ehAssetDoApp(url) || ehRotaDoShell(url.pathname))
              );
            } catch {
              return false;
            }
          })
          .map((u) => cache.add(new Request(u, { credentials: "same-origin" })).catch(() => {}))
      );
    })()
  );
});

// ---------- Requisições ----------

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Não-GET nunca passa por aqui: escrita não tem cache.
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // Outra origem: o Worker não se mete.
  if (url.origin !== self.location.origin) return;

  // A regra mais importante do arquivo.
  if (url.pathname.startsWith("/api/")) return;

  // Payload RSC carrega estado de servidor — vai sempre à rede.
  if (url.searchParams.has("_rsc")) return;

  if (ehAssetDoApp(url)) {
    event.respondWith(assetRedePrimeiro(req));
    return;
  }

  if (req.mode === "navigate" && ehRotaDoShell(url.pathname)) {
    event.respondWith(navegacaoRedePrimeiro(req, url));
    return;
  }

  // Todo o resto: rede, sem cache. Inclui /login, /dashboard e o que mais
  // exista — nenhum deles é o escopo desta fase.
});

/**
 * Pedaços do aplicativo: REDE PRIMEIRO, cache como rede de segurança.
 *
 * Cache primeiro seria mais rápido, e foi a primeira escolha. Está errada por
 * dois motivos, e o segundo é o que decide:
 *
 *   1. em produção o ganho é pequeno — o Firebase Hosting já serve
 *      `/_next/static/**` como `immutable`, e o cache HTTP do navegador
 *      resolve a repetição sem nós;
 *   2. em desenvolvimento seria um defeito diário: os pedaços do `next dev`
 *      trocam de conteúdo SEM trocar de nome, e cache primeiro entregaria
 *      JavaScript velho depois de cada edição. Quem programa o Helo passaria a
 *      caçar bugs que já tinha corrigido.
 *
 * Este Service Worker não é uma camada de velocidade. Ele é uma rede de
 * segurança para quando não há rede — e uma rede de segurança que se mete no
 * caminho quando há rede não é rede de segurança, é risco.
 */
async function assetRedePrimeiro(req) {
  const cache = await caches.open(CACHE);
  try {
    const resposta = await fetch(req);
    if (resposta && resposta.ok && resposta.type === "basic") {
      cache.put(req, resposta.clone()).catch(() => {});
    }
    return resposta;
  } catch (erro) {
    // `ignoreSearch` não é detalhe: em desenvolvimento o Next anexa um
    // `?v=<timestamp>` aos pedaços, e ele MUDA a cada reinício do servidor. Com
    // a busca no casamento, o cache errava por uma query que não identifica
    // nada — a tela abria e o JavaScript não. Em produção os nomes já derivam
    // do conteúdo e não há query, então ignorá-la é inofensivo.
    const guardado = await cache.match(req, { ignoreSearch: true });
    if (guardado) return guardado;
    throw erro;
  }
}

/**
 * A tela da sessão: REDE PRIMEIRO, cache só como rede de segurança.
 *
 * A ordem importa e não é negociável. Servir do cache primeiro entregaria uma
 * tela possivelmente velha a quem está com conexão — e "possivelmente velho"
 * não é uma categoria aceitável num prontuário. Com servidor no ar, o servidor
 * sempre ganha; o cache só aparece quando não há resposta nenhuma.
 *
 * A cópia é guardada mesmo quando o cabeçalho diz `no-store`: este HTML é
 * pré-renderizado, não tem dado de usuário, e nunca é preferido à rede. A
 * decisão de guardá-lo é da aplicação, e é só para o caso de não haver rede.
 */
async function navegacaoRedePrimeiro(req, url) {
  const cache = await caches.open(CACHE);
  try {
    const resposta = await fetch(req);
    if (resposta && resposta.ok && resposta.type === "basic") {
      cache.put(url.pathname, resposta.clone()).catch(() => {});
    }
    return resposta;
  } catch {
    const guardado =
      (await cache.match(url.pathname)) ||
      (await cache.match(req, { ignoreSearch: true }));
    if (guardado) return guardado;
    return respostaSemShell();
  }
}

/**
 * Último recurso: nem rede, nem cache. Acontece quando o cuidador nunca abriu
 * esta tela COM conexão neste aparelho — e aí não há o que continuar, porque
 * também não há sessão guardada. A tela diz isso, em vez de mostrar o erro do
 * navegador.
 */
function respostaSemShell() {
  return new Response(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Helo — sem conexão</title>
<style>
  body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;
       font-family:system-ui,-apple-system,sans-serif;background:#f5f3f0;color:#26221f;padding:24px}
  main{max-width:32rem;text-align:center}
  h1{font-size:1.5rem;font-weight:500;margin:0 0 .75rem}
  p{margin:0;line-height:1.6;color:#6b625a}
</style></head><body><main>
<h1>Sem conexão</h1>
<p>Esta tela ainda não foi aberta com conexão neste aparelho, então não há
conversa guardada aqui para continuar. Conecte-se uma vez e ela passa a
funcionar mesmo sem rede.</p>
</main></body></html>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
