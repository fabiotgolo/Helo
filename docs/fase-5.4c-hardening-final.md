# Fase 5.4C — Hardening de endpoints, rate limiting, cache, logs e contrato externo

## 1. Resumo executivo

**A-10 fechado.** O produto não tinha um único limitador de taxa. Agora sete
endpoints consomem limite antes de gastar dinheiro, com contador distribuído no
Firestore, transacional, e provado sob concorrência real: vinte pedidos
simultâneos passam exatamente doze.

**A-10b fechado.** A 5.4A tinha lido o código e listado rotas sem
`Cache-Control`. A 5.4C **mediu**, contra uma build de produção: o Next 16.2.10
não emite `Cache-Control` nenhum em route handler — nem no sucesso, nem no erro.
Não havia default a herdar. Treze rotas sensíveis passaram a dizer `no-store`,
no sucesso **e** na recusa, e a suíte confere isso no HTTP.

**A-09 fechado**, com uma linha a mais do que a auditoria tinha encontrado: a
varredura desta fase cobriu o app inteiro em vez de uma lista, e achou
`[HELO ROUTINE] selected answer text` — o texto da resposta clínica do paciente
no console do navegador.

**A-10c parcialmente fechado**, e a razão é a descoberta abaixo.

---

### A descoberta que muda a leitura de tudo

Medir o `Cache-Control` real exigia consultar o ambiente publicado. A sonda
escolhida não tem custo, não toca no provedor, não altera dado nenhum e não usa
paciente nem credencial: um `POST` malformado que a rota recusa com 400 antes de
qualquer coisa. A resposta veio, e junto veio outra coisa:

| Rota | Criada em | Produção responde |
| --- | --- | --- |
| `/api/tts` | 2026-07-08 | **400** — existe |
| `/api/patients/{id}/observations` | 2026-07-24 | **400** — existe |
| `/api/realtime-questions/sessions` | 2026-08-02 | **404** |
| `/api/realtime-questions/preflight` | 2026-08-07 | **404** |
| `/api/voice/grant` | 2026-08-08 (5.1A) | **404** |
| `/api/voice/dictation` | 2026-08-08 (5.2A) | **404** |

> **A build em produção é anterior a 2026-08-02.** Ela é anterior ao próprio
> branch `rescue-imported-2026-08-02` e a toda a Fase 5.

O que isso significa, dito sem rodeio: **tudo o que as fases 5.1A, 5.1B, 5.2A,
5.2B, 5.3A/B/C, 5.4B e 5.4C fecharam está fechado no repositório, não no que
atende os usuários agora.** Em produção, hoje:

- não existe `/api/voice/grant` — logo o SpeechGrant (R-01) não está em vigor;
- não existe a rota de mídia privada — logo o R-04 continua aberto **e continua
  produzindo URLs públicas novas a cada frase sintetizada**;
- o ditado (R-02/5.2A) e as rotas de conversa por opções não existem.

Isso não é uma pendência desta fase — é o estado do ambiente. Mas reordena a
pendência que a 5.4B deixou: **migrar os dados legados do R-04 sem antes
publicar o código que parou de gerá-los seria enxugar gelo.** Ver §32.

Nenhuma condição de parada da §92 do escopo foi encontrada no código.

---

## 2. Baseline 5.4B

| Item | Valor |
| --- | --- |
| HEAD/origin no início | `716d6956120f05f9312c99e76f08c708306c0ac7` |
| Tag no HEAD | `ponto-seguranca-fase-5.4b` |
| Actions | 47 — navigation 9, operational 16, sensitive 12, patientResponse 10 |
| Agent-executable | 25 |
| lint | 55 erros / 6 warnings |
| Playwright | 282/282, 18 lotes |

Nada disso mudou. A 5.4C não criou action, não reclassificou nenhuma, não tocou
em autoria, transcript, STT nem SpeechGrant.

---

## 3. A-10 — o inventário antes do limite

Todos os endpoints provider-facing, com o que decidiu a prioridade:

| Endpoint | Custo | Abuso possível | Frequência legítima | Auth | Patient-bound | Limite? | Prioridade |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/generateMusic` (Function) | **alto** — até 300 s de composição paga + MP3 | esgotar a cota da conta | 1–3 por sessão | cookie `__session` | sim | **sim** | 1 |
| `/synthesizePhraseAudio` (Function) | médio — TTS + Storage | gerar áudio em massa | rajada ao montar a lista | cookie `__session` | sim | **sim** | 2 |
| `/api/tts` | médio — TTS por caractere | esgotar cota; laço de fala | rajada legítima (Emergência) | `requireUser` | quando é voz do paciente | **sim** | 3 |
| `/api/voice/grant` | nenhum (HMAC) | tentativa repetida; enumeração de recursos | uma por síntese não cacheada | cookie | sim | **sim** | 4 |
| `/api/helo/conversation-token` | alto por sessão | spam de conexões | uma sessão por vez | cookie | sim | **sim** | 4 |
| `/api/voice/dictation` | médio — STT + upload | exaustão de recurso | desligado em produção | `requireUser`/cookie | sim | **sim** | 5 |
| `/api/admin/voices` (POST) | baixo — consulta à conta | **enumeração** da biblioteca | cadastro manual | `requireAdmin` | não | **sim** | 6 |
| `/api/helo/client-tools` | **nenhum** | — | uma por tool call do Agent | cookie | sim | **não** | — |
| `/webhook/generate_music` | igual a `/generateMusic` | igual | nenhuma conhecida | cookie | sim | **herda** | 1 |

`/api/helo/client-tools` ficou de fora deliberadamente: ela não gasta nada
externo, é chamada várias vezes por conversa, e um teto ali atrapalharia o
Agent sem proteger dinheiro nenhum.

---

## 4. O modelo do limitador

```
lib/rate-limit.ts        →  app Next (5 endpoints)
functions/index.js       →  Cloud Functions (2 endpoints)
```

Duas cópias, pela mesma razão que `patientAccess` e `midia-privada` são
duplicados: **as Functions não compartilham código com o app Next.**
`test:rate:limite` §0 confere que os dois lados concordam — e a tabela do lado
das Functions é *executada* pelo teste, não relida.

### Por que não um contador em memória

`apphosting.yaml` traz `minInstances: 0`. A instância morre quando o uso para, e
com ela morreria o contador — o limite se apagaria sozinho a cada pausa. As duas
Functions escalam à parte, com o padrão da plataforma. Um contador local não
seria frouxo: seria decorativo.

### Por que janela fixa

O balde é `(endpoint, usuário[, paciente], índice da janela)`, com o índice
igual a `floor(agora / janela)`. Três razões concretas:

1. **O `Retry-After` fica exato.** O fim da janela é conhecido, então o valor
   devolvido é o verdadeiro, não uma estimativa.
2. **É uma leitura e uma escrita.** Uma janela deslizante honesta guarda a lista
   de instantes.
3. **A limpeza vira estrutural.** Cada janela tem documento próprio, então o
   lixo é identificável sem varredura.

O preço é conhecido e aceito: na virada, um usuário pode emitir até `2 × limite`
num intervalo curto. Para um limitador de **custo**, o que importa é o teto por
hora.

### Por que transação

`FieldValue.increment` é atômico mas **não devolve o valor novo**, e sem o valor
novo não há decisão. Fora de uma transação, duas requisições simultâneas leem
`limite - 1` e ambas passam — exatamente o que o limite existe para impedir.

Custo: uma leitura e uma escrita por requisição limitada.

### A chave

```
{endpoint}__{userId}__{patientId|-}__{índiceDaJanela}
```

Só identificadores técnicos opacos: o id do documento do usuário (gerado pelo
Firestore, 20 caracteres) e, quando aplicável, o id numérico interno do
paciente. **Nunca** nome, e-mail, texto clínico, prompt ou título — e a suíte
confere isso lendo as chaves reais gravadas no banco.

**IP não aparece em lugar nenhum.** Cuidadores de uma mesma instituição saem
pelo mesmo NAT, e limitar por IP puniria a equipe inteira por causa de uma
pessoa. Todos estes endpoints são autenticados: existe identidade melhor que o
endereço.

---

## 5. Endpoints protegidos, limites e justificativas

Nenhum número aqui é preferência. Cada um sai de um uso real medido no código.

| Endpoint | Limite | Janela | Unidade | Por quê |
| --- | --- | --- | --- | --- |
| música | **6** | 1 h | usuário | Cada chamada compra até 300 s de composição paga. Seis por hora é generoso para quem também precisa **escutar** o que pediu. Por usuário e não por paciente: quem paga é a conta, e somar por paciente daria a quem cuida de mais gente um teto maior sem razão |
| síntese de frase | **30** | 1 h | usuário + paciente | Montar a lista de frases favoritas é uma rajada legítima, e cada edição de texto re-sintetiza. Trinta cobre montar a lista inteira e ainda corrigir várias. Por paciente porque a rajada é por paciente |
| `/api/tts` | **60** | 1 min | usuário | O pior caso legítimo está medido: a Emergência pré-aquece o áudio de todas as frases ao entrar na tela, e `lib/voice/audio-cache.ts` documenta esse conjunto como "15 no pior caso realista". Sessenta deixa o pré-aquecimento inteiro passar **quatro vezes** no mesmo minuto |
| `/api/voice/grant` | **90** | 1 min | usuário | É o passo anterior a cada síntese que não vem do cache, então precisa ser ≥ o de TTS com folga. Não gasta crédito: o que ele protege é a tentativa repetida |
| conversation-token | **12** | 5 min | usuário | Uma sessão por vez é o uso real; doze cobre reconexões seguidas numa rede ruim, que é o único caminho legítimo que repete este pedido |
| ditado | **20** | 1 min | usuário | Cada chamada carrega um arquivo. Entra agora, com o recurso **desligado**, para que a ativação futura não dependa de ninguém lembrar |
| `/api/admin/voices` | **60** | 1 min | usuário | O alvo não é custo, é **enumeração**: é o único ponto que consulta a conta da ElevenLabs |

### O que nenhum limite atrapalha

O escopo é explícito sobre não reduzir segurança clínica por um limitador
financeiro. A operação de emergência **chama o provedor** (a fala do paciente na
voz clonada dele), e foi tratada explicitamente:

- o teto de TTS cabe quatro pré-aquecimentos completos por minuto;
- e quando alguém bate no teto, **a voz não some**. Um 429 não é falha
  transitória para `lib/voice/eleven-availability.ts` — só 502/503/504 e rede
  são —, então a aba **não** entra em prazo de indisponibilidade: a fala cai no
  fallback do navegador naquele instante e a seguinte tenta de novo.

---

## 6. Ordem: o limite não decide autoridade

O limite roda **depois** da autenticação e da autorização, e **antes** da
chamada paga. A ordem não é detalhe.

Se ele viesse antes da autorização, uma fala **proibida** voltaria 429 em vez de
403 quando o usuário estivesse no teto — e a 5.1A construiu `/api/tts` para que
uma fala não autorizada seja recusada como não autorizada, inclusive com o
provedor fora do ar. O limite protege o dinheiro; ele não opina sobre autoria, e
não deve poder mascarar a recusa que opina.

Consequência conferida em teste: **um anônimo insistente não cria balde nenhum.**
Ele recebe 401 e nunca 429 — e assim o limite não vira um canal que conta a um
desconhecido quanto alguém andou usando o sistema.

`requirePatientAccess`, SpeechGrant e o action gate seguem intactos. O limitador
não substitui nenhum deles.

---

## 7. Comportamento em falha

A regra do escopo é clara: "Firestore indisponível → libera chamadas infinitas"
não pode acontecer. Aqui não acontece, e a razão é **estrutural em vez de
configurada**: o limitador guarda o estado no mesmo Firestore de que a
autorização depende. `requirePatientAccess` lê a sessão, o usuário e o vínculo
do banco. Com o banco fora do ar, nenhuma requisição chega ao ponto de consultar
o limitador — ela já foi recusada antes, na autenticação.

`falhaFechada` decide, portanto, o que fazer numa falha **parcial**: a leitura
da sessão funcionou e a transação do balde não.

| Endpoint | Falha | Por quê |
| --- | --- | --- |
| música | **fecha** (503) | Custo alto, nada clínico. Não gastar é sempre reversível |
| síntese de frase | **fecha** (503) | A frase continua sendo falada pelo caminho do grant — a pré-síntese só otimiza |
| ditado | **fecha** (503) | Upload + STT; desligado em produção de todo modo |
| `/api/tts` | **abre**, com registro | Recusar silenciaria a voz do paciente, inclusive na Emergência, por causa de um contador |
| `/api/voice/grant` | **abre**, com registro | É o portão da fala; ele já tem o SpeechGrant como controle real |
| conversation-token | **abre**, com registro | Derrubar a conversa por um contador é pior que a conversa a mais |
| `/api/admin/voices` | **abre**, com registro | Superfície mínima, admin-only |

O registro da falha é sanitizado: endpoint, decisão e o **nome** do erro. Nunca
a mensagem do driver, o caminho do documento ou a identidade.

---

## 8. A resposta 429

```
HTTP 429
Retry-After: <segundos até o fim da janela>
Cache-Control: no-store

{ "error": "muitos pedidos em pouco tempo", "reason": "rate_limited" }
```

`Retry-After` é **exato**, não estimado: a janela é fixa, então o segundo em que
ela vira é conhecido. Um valor inventado seria pior que nenhum.

O corpo não devolve — e a suíte confere um a um — contador interno, limite
configurado, `patientId`, e-mail, caminho de Firestore ou cota do provedor.

Quando é o próprio limitador que falha (fail-closed), o status é **503**, não
429: 429 diria "você pediu demais", e não foi isso que aconteceu.

---

## 9. TTL e crescimento da coleção

Cada balde carrega `expiraEm`, um `Timestamp` do Firestore — o tipo que uma
política de TTL sabe ler.

**Mas o produto não depende de essa política existir.** O primeiro pedido de uma
janela apaga o balde da janela **anterior** daquela mesma chave: uma exclusão
por id, sem consulta e sem índice, com prazo de 2 s e best-effort. A coleção
nunca guarda mais de duas janelas por chave.

A política de TTL continua sendo recomendada como segunda linha, e é
**configuração externa** — não foi aplicada por esta fase:

```bash
gcloud firestore fields ttls update expiraEm --collection-group=rateLimits --database=helo-db --enable-ttl --project=helo-app-7fbf8
```

### Segurança do armazenamento do limitador

`firestore.rules` nega leitura e escrita ao cliente no documento raiz — o
navegador não fala com o Firestore. `test:rate:limite` §1 confere o arquivo, e
os documentos guardam **só** `contagem` e `expiraEm`: nada de quem, nada de quê.

---

## 10. A-10b — Cache-Control

### O que foi medido

Uma build de **produção** do Next 16.2.10, levantada localmente, consultada em
catorze rotas. **Nenhuma emitiu `Cache-Control`** — nem no 200, nem no 400, nem
no 401. Não existe default do framework a herdar; o que não está escrito na rota
não existe na resposta.

### Classificação

| Resposta | Política | Estado |
| --- | --- | --- |
| `/api/tts` | NO_STORE | já tinha |
| `/api/voice/grant` | NO_STORE | já tinha (e agora também nas recusas) |
| `/api/voice/dictation` | NO_STORE | já tinha (e agora nas guardas de auth) |
| `/api/helo/conversation-token` | NO_STORE | **acrescentado** |
| `/api/helo/client-tools` | NO_STORE | **acrescentado** |
| `/api/voices` | NO_STORE | **acrescentado** |
| `/api/voice-preference` | NO_STORE | **acrescentado** |
| `/api/patient-voice-source` | NO_STORE | **acrescentado** |
| `/api/admin/voices` | NO_STORE | **acrescentado** |
| `/api/admin/patient-voice` | NO_STORE | **acrescentado** |
| `/api/auth/me` | NO_STORE | **acrescentado** |
| `/api/favorite-phrases/audio` | `private, no-store` (5.4B) + NO_STORE nas recusas | **completado** |
| `/api/patients/{id}/playlist/audio` | `private, max-age=0, must-revalidate` (5.4B) + NO_STORE nas recusas | **completado** |
| `/api/media` | PRIVATE_REVALIDATE (`private, max-age=3600`) | inalterado |
| demais rotas de dados | NÃO APLICÁVEL nesta fase | ver §35 |

### Por que rota a rota, e não uma camada

A tentação era um `proxy.ts` — o que o Next 16 passou a chamar o antigo
`middleware.ts` — carimbando `/api/:path*` de uma vez. Foi descartado por três
motivos, nesta ordem:

1. **A documentação do próprio Next desaconselha.** O guia embarcado diz,
   textualmente, para evitar depender de Middleware/Proxy a menos que não exista
   outra opção.
2. **A precedência não é documentada.** Um header posto pelo Proxy — ou pela
   configuração global de `headers()` — sobre uma rota que já define o seu não
   tem regra escrita em lugar nenhum do guia. E a 5.4B definiu, com razão,
   `private, max-age=0, must-revalidate` para a música: um carimbo global de
   `no-store` transformaria cada arrasto da barra de progresso numa descida nova
   do arquivo inteiro. Trocar um risco de privacidade por uma regressão de
   produto seria mau negócio.
3. **O escopo é explícito** sobre não alterar configuração global às cegas.

O preço da escolha é honesto: **uma rota nova não herda a política.** Por isso a
suíte confere o resultado no HTTP — quem esquecer verá um teste vermelho, não um
revisor atento.

### Por que `no-store` e não `private, no-store`

`private` é redundante sob `no-store`, que já proíbe qualquer cache. O produto
já usava `no-store` puro em `/api/tts`, `/api/voice/grant` e
`/api/voice/dictation` desde a 5.1A. Uma string só, e a que já estava lá. As
rotas de **mídia** mantêm o que a 5.4B definiu, onde `private` convive com um
`max-age` e não é redundante.

### Sucesso e erro

O padrão que a auditoria encontrou era o header no 200 e ausente no 401. Uma
recusa também carrega contexto: "sem vínculo com este paciente", guardado por um
intermediário, conta a quem a recebe que aquele paciente existe. Cada rota é
conferida nos dois estados, incluindo 400, 401, 403, 404, 429 e 503.

---

## 11. A-10c — o Hosting, medido

### Separando as três camadas, como o escopo pede

| Camada | O que se sabe |
| --- | --- |
| **Header definido pelo app** | Medido, na build de produção, depois da correção: as 13 rotas sensíveis emitem `no-store`; `/api/items` e `/api/settings`, deixadas de fora de propósito, continuam sem header — é a prova de que a mudança é dirigida e não um carimbo geral |
| **Header observado no deploy** | Medido: `GET /api/auth/me` em `heloapp.web.app` volta com `cache-control: no-cache`. A rota **não definia header nenhum** naquela versão, então o `no-cache` é da camada de Hosting. `POST /api/tts` volta **sem header nenhum** — a camada não carimba método não-cacheável |
| **Header configurado no Hosting** | `firebase.json` tem `{"source": "**", "headers": [{"Cache-Control": "no-cache"}]}`. O deploy responde com `x-fah-adapter: nextjs-…`, ou seja, **Firebase App Hosting** — que tem defaults próprios. Não é possível distinguir, de fora, se o `no-cache` observado vem da regra do `firebase.json` ou do default do App Hosting |

### O que NÃO foi medido, e por quê

**A pergunta central do A-10c — "o `no-cache` do Hosting sobrepõe o `no-store`
da rota?" — continua sem resposta**, e por um motivo que não é preguiça:

*não existe, no deploy atual, nenhuma rota GET que defina `no-store` e possa ser
consultada sem sessão.* As que definem `no-store` ou são POST (que a camada não
carimba) ou **não existem na build publicada** — é a descoberta da §1.

Portanto:

> **A-10c = PARCIALMENTE FECHADO.**
> Código correto e medido localmente. Sobreposição do Hosting **não medida** —
> e não mensurável antes de um deploy do código atual.

A sonda para o momento em que houver deploy, sem custo e sem efeito:

```bash
curl -sI -X POST https://heloapp.web.app/api/voice/dictation
```

Ela recusa com 400 antes de tocar em qualquer coisa, e a rota emite `no-store`.
Se a resposta vier `no-cache`, o Hosting sobrepõe e o conserto é retirar a regra
`**` do `firebase.json` — não mexer nas rotas.

**Nenhuma configuração de Hosting foi alterada nesta fase.**

---

## 12. A-09 — logs residuais

Oito linhas, uma a mais do que a auditoria tinha:

| Linha | Era | Ficou |
| --- | --- | --- |
| `interactWithHeloUI called` | `rawId` + **o objeto `parameters` inteiro** | só o evento |
| `unhandled client tool call` | **a chamada inteira**, com parâmetros | só o **nome** da tool |
| `agent connected` | `{ conversationId }` do provedor | só o evento |
| `agent disconnected` | **o objeto `details`** do SDK | só `details.reason` |
| `agent error` | **`message` + `context` do provedor** | um código estável |
| 3 × `catch` de música/áudio | **o objeto de erro inteiro** | só o rótulo |
| teardown do lifecycle | `detail` do SDK | só a mensagem da Helo |
| **`[HELO ROUTINE] selected answer text`** | **o texto da resposta clínica do paciente** | removida |

A última não estava na auditoria da 5.4A, e a razão é instrutiva: a 5.4A varreu
os **caminhos do Agent**, e essa linha é da tela de Rotina. A suíte desta fase
varre o app inteiro contra uma lista de identificadores de conteúdo — foi ela
que a encontrou.

### A que mais importava

`onError` não parava no console: a mensagem do provedor era **mostrada ao
cuidador**. É o mesmo defeito que a 5.4B corrigiu na música, onde uma falha de
rede virava "Failed to fetch" na voz da Helo. O que a pessoa lê passa a ser
sempre escrito pela Helo.

### O que continua sendo registrado

Código, operação, status, duração, booleano, tamanho e id técnico não sensível.
Nunca transcrição, mensagem digitada, `patientId` em log de navegador,
`patientName`, argumento clínico de tool, `audioUrl`, `storagePath`,
SpeechGrant, token de conversa, erro bruto do provedor, prompt ou variável
dinâmica sensível.

### Não tocado, e dito

`app/(palco)/rotina/page.tsx` tem um `console.log` que a si mesmo se declara
"log temporário" e imprime **contagens** de ações registradas. Não é conteúdo,
não é identificador, e removê-lo seria limpeza estética — que esta fase não faz.
Fica registrado aqui para quem quiser decidir depois.

---

## 13. Exposição de erro

Reauditados os endpoints tocados:

| Origem | O que sai ao cliente |
| --- | --- |
| todas as rotas de voz | `{ error, reason }` com categoria fechada |
| limite excedido | `{ error, reason: "rate_limited" }` |
| limitador indisponível | `{ error, reason: "rate_limit_unavailable" }` |
| `generateMusic` | `{ error, code: "MUSIC_GENERATION_FAILED" }` |
| sessão do Agent (navegador) | texto escrito pela Helo, sempre |

`response.text()` continua não existindo em caminho de provedor — conferido
sobre a fonte **sem comentários**, porque a nota que explica a remoção cita o que
foi removido.

---

## 14–18. Endpoints, um a um

**`/api/helo/conversation-token`** — `no-store` acrescentado, limite de 12/5min,
token nunca registrado, erro categorizado. O WebRTC não foi redesenhado.

**`/api/helo/client-tools`** — `no-store` acrescentado. **Sem limite**, por
decisão: não gasta nada externo e um teto atrapalharia o Agent sem proteger
dinheiro. O R-09 segue fechado: não devolve DOM, não devolve `patientResponse`,
não ganhou autoridade.

**`/api/tts`** — SpeechGrant intacto (`test:voice:authorization` 32/32). Limite
de 60/min depois de toda a autorização e antes da chamada paga. Texto autorizado
inalterado; TTL do grant inalterado.

**`/api/voice/dictation`** — produção continua com `HELO_VOICE_DICTATION_ENABLED`
ausente, que é o mesmo que `false`. **Não foi alterado.** O limite entra depois
da flag: com o recurso desligado, a recusa é de graça e não consome cota de
ninguém. ZRM continua requisito para qualquer ativação futura.

**`/generateMusic`** — limite obrigatório de A-10 aplicado: 6/hora por usuário,
antes da composição. R-07a, R-07b, R-14 e A-12 seguem fechados
(`test:music:authorization` 17/17).

---

## 19. R-12 — override morto da voz do Agent

**PRESERVADO.** O caminho continua morto — `openAgentSession` chama
`deps.requestToken(true)` com `true` literal — e continua sendo a implementação
pronta de um recurso bloqueado por uma configuração do painel ("Voice ID
override"). O §4 do checklist não foi preenchido.

> **R-12 = PENDENTE DE CONTRATO EXTERNO.**

---

## 20. A-11 — aliases legados

**PRESERVADOS.** Cinco nomes de tool e nove aliases de parâmetro. A comparação
com o painel não foi possível, e o escopo é explícito: só remover depois de
confirmar. Continuam congelados em `test:5.4a:superficie` §6 — um décimo sexto
nome quebra a suíte.

Isso não é falha da fase, mas impede declarar a limpeza externa concluída.

---

## 21. A-13 — envs órfãs

| Variável | Lida? | Onde é configurada | Removida? |
| --- | --- | --- | --- |
| `ELEVENLABS_HELO_VOICE_FEMALE_ID` | era, como alias | **em lugar nenhum** — no `apphosting.yaml` é o nome do SECRET, não da variável | **sim** |
| `ELEVENLABS_HELO_VOICE_MALE_ID` | idem | idem | **sim** |
| `ELEVENLABS_HELO_PLATFORM_VOICE_*` | sim | `apphosting.yaml`, `.env.local` | não — é a interface atual |
| `ELEVENLABS_HELO_VOICE_OVERRIDE_ENABLED` | sim | `apphosting.yaml`, `.env.local` | não — R-12 |
| `ELEVENLABS_HELO_VOICE_ID` | sim | `.env.example` | não — migração de catálogo |
| `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` (R-13) | **por ninguém** | só `.env.local`, que é gitignored | **não pode ser** — ver abaixo |

Os dois aliases foram conferidos nos três lugares onde uma variável pode nascer
neste projeto (`apphosting.yaml`, `.env`, `.env.local`) e **não existem em
nenhum**. Os *secrets* do App Hosting com esses nomes continuam intocados: o que
saiu foi a leitura de um nome que nunca chega ao processo.

**R-13**: `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` existe só no `.env.local`, que não é
versionado. O repositório não tem o que remover — ela já é inerte, porque o Next
só inlina o que é referenciado. Fica como uma linha para apagar à mão, sem
efeito nenhum:

```bash
sed -i '' '/^NEXT_PUBLIC_ELEVENLABS_AGENT_ID=/d' .env.local
```

---

## 22. `/webhook/generate_music`

Reauditado no código atual:

| Item | Estado |
| --- | --- |
| Existe? | sim, em `functions/index.js` (`app.post([…, "/webhook/generate_music"])`) |
| Método | POST |
| Autenticação | cookie `__session` — o **mesmo handler** de `/generateMusic` |
| Assinatura / secret / replay | **não existem** |
| Patient binding | sim, `patientAccess(patientId, "createSession")` |
| Efeito colateral | idêntico ao endpoint principal |
| Logs | `console.warn` de rota depreciada, sem conteúdo |
| Rate limit | **herda** o de `/generateMusic` — o handler é o mesmo |
| Referenciado pelo painel? | **desconhecido** |

Como a ElevenLabs não teria cookie de sessão do cuidador, uma server tool que
ainda aponte para cá **já está quebrada, e do jeito certo**: recebe 401. A
ausência de assinatura não é risco enquanto não existir caminho anônimo com
efeito — e não existe.

> **Classificação: NÃO VERIFICADO EXTERNAMENTE.** Nenhum protocolo foi inventado;
> a remoção depende do §5.2 do checklist.

---

## 23–29. Contrato externo — o portão

`docs/elevenlabs-agent-contract-checklist.md` está **inteiramente em branco**.
Nenhum dos dez blocos foi preenchido.

| Item | Painel | Local | Diverge? | Ação |
| --- | --- | --- | --- | --- |
| System Prompt | **não visto** | — | **não verificável** | preencher §2 do checklist |
| First Message | **não visto** | envia `heloPatientGreeting` | não verificável | §3 |
| Voice / Model / Language | **não visto** | — | não verificável | §4 |
| "Voice ID override" habilitado? | **não visto** | código pronto, desligado | **decide o R-12** | §4 |
| Tools declaradas | **não vistas** | 15 nomes (10 + 5 aliases) | não verificável | §5 |
| Schemas de parâmetro | **não vistos** | 9 aliases aceitos | não verificável | §5.1 |
| Server tools / webhook | **não vistas** | `/webhook/generate_music` vivo | **decide o webhook** | §5.2 |
| Dynamic variables | **não vistas** | 12 enviadas | **decide `patientName`/`activePatientId`** | §6 |
| Knowledge Base | **não vista** | nenhuma ingestão pelo Helo | não verificável | §7 |
| Retenção / logging | **não vistos** | STT com `enable_logging=false`; TTS/Agent/Music sem parâmetro | não verificável | §8 |

**Nada foi inferido, e o painel não foi alterado.** Não existe artefato de
contrato versionado (`docs/elevenlabs-agent-contract.md`) porque não há
informação real para versionar — criar um arquivo com campos vazios seria
fingir que o contrato foi visto.

### `patientName` e `activePatientId`

Continuam **enviados**, com a classificação que a 5.4B deu: *desnecessários
localmente, contrato externo não verificado*. Removê-los sem ver o System Prompt
é arriscar quebrar o Agent por uma otimização não comprovada. `preferredName`
cobre o uso do lado de cá; `activePatientId` não é aceito de volta por caminho
nenhum — o gate ignora qualquer `patientId` vindo do Agent.

### Retenção — o que não muda

Grant Tier 2 sem ZRM no workspace: **o ditado em produção continua desabilitado.**
Nada aqui altera ZRM, e nenhuma chamada foi feita para "testar retenção".

---

## 30–31. O que continua fechado

| Risco | Estado | Prova |
| --- | --- | --- |
| **R-04 (código)** | FECHADO | `getDownloadURL`/`getSignedUrl`/`makePublic`/`firebaseStorageDownloadTokens` continuam sem nenhuma ocorrência funcional — `test:midia:privada` 97 |
| **R-04b** | FECHADO | ordem save→swap→sweep intacta |
| **R-07a / R-07b** | FECHADO | prompt e corpo do provedor fora do log |
| **R-08** | FECHADO | autoria e roles não tocados |
| **R-09** | FECHADO | `test:agent:inventory` 42, `test:agent:capabilities` 47 |
| **R-14** | FECHADO | tool result sem endereço |
| **A-12** | FECHADO | música sob o paciente |
| **SpeechGrant** | INTACTO | `test:voice:grant` 32, `test:voice:authorization` 32 |
| **Storage Rules** | VERDES | `test:storage:rules` 17 |
| **Autoridade do Agent** | INALTERADA | 47 actions · 9/16/12/10 · 25 Agent-executable |

Nenhuma signed URL curta foi introduzida "temporariamente".

---

## 32. Migração do R-04 em produção

**NÃO EXECUTADA.** Revalidada, item a item:

| Requisito | Estado |
| --- | --- |
| script existe | `scripts/migrar-midia-privada.mjs` |
| dry-run é o padrão | sim; `--apply` é explícito |
| recusa execução ambígua | sem emulador e sem `--producao`; `--producao` sem `--confirmo-projeto <id>`; `--producao` **com** emulador |
| idempotente e retomável | sim |
| não imprime dado sensível | nem texto, nem prompt, nem título, nem download token |
| suporta bucket legado | sim (`caminhoDaFaixa` devolve caminho **e** bucket) |
| documentado | `docs/migracao-midia-privada-5.4b.md` |
| testado | `test:migracao:midia` 40 |

> **MIGRAÇÃO DE PRODUÇÃO = PENDENTE DE AUTORIZAÇÃO HUMANA.**

### O gate obrigatório antes de encerrar a Fase 5

A Fase 5 **não pode ser encerrada** enquanto as URLs legadas potencialmente
públicas não tiverem sido (1) inventariadas em dry-run, (2) revisadas, (3)
migradas com autorização, (4) verificadas, e (5) comprovadamente invalidadas.

E a §1 acrescenta um passo **antes** desses cinco: **publicar o código.**
Migrar os dados enquanto a produção roda uma build que ainda gera `audioUrl` a
cada frase sintetizada limparia o passado e continuaria produzindo o presente.
A ordem correta é deploy → dry-run → revisão → migração autorizada → verificação.

---

## 33. Testes

### Novos — 126 asserções

| Suíte | Asserções | O que responde |
| --- | --- | --- |
| `test:rate:limite` | **58** | contagem, concorrência (20 simultâneos → 12), isolamento por usuário e por endpoint, virada de janela, limpeza da janela anterior, 429, `Retry-After`, higiene da chave, campos do documento, anônimo não conta, gêmeos concordam |
| `test:cache:politica` | **43** | headers de 13 rotas em 200/400/401/403/404/429/503 |
| `test:logs:agente` | **25** | marcadores sintéticos por HTTP + estrutura dos `console.*` do app inteiro |

### Existentes

gate 53 · invariants 23 · inventory 42 · capabilities 47 · contexto 49 · stale 53
· autoria do Agent 36 · lifecycle 33 · teardown 12 · grant 32 · callsites 14 ·
eleven-guard 46 · superfície 45 · mídia privada 97 · cache de áudio 42 · ciclo de
vida de áudio 62 · cancelamento 58 · timeout 53 · autoria 53 · música 17 ·
autorização de voz 32 · autorização de mídia 35 · Storage Rules 17 · migração 40
· endpoint de ditado 60.

---

## 34. Limitações desta fase

1. **A produção roda uma build anterior à Fase 5** (§1). Nada do que foi
   fechado desde 5.1A está em vigor para os usuários.
2. **A sobreposição do Hosting não foi medida** (§11) e não é mensurável antes
   de um deploy do código atual.
3. **O contrato do painel continua não verificado**, e com ele R-12, A-11, o
   webhook, `patientName` e `activePatientId`.
4. **A migração de produção não foi executada.**
5. **A política de TTL do Firestore não foi aplicada** — é configuração externa,
   e o produto não depende dela (§9).
6. **As Functions não foram executadas de verdade.** O limitador delas é provado
   pela concordância com o gêmeo (executando o construtor real de chave) e pelo
   dublê da suíte de música; a prova transacional contra o Firestore de verdade
   é a do lado do app Next.
7. **A janela fixa permite `2 × limite` na virada.** Aceito para um limitador de
   custo; registrado para quem for ler os números.

---

## 35. O que ficou de fora, e por quê

Rotas de dados que devolvem estado de paciente (`/api/items`, `/api/settings`,
`/api/activities`, e as demais) **não** receberam `Cache-Control`. Elas estão
fora da lista de endpoints desta fase, e a alternativa — um carimbo global —
foi descartada pelos motivos da §10. Isso é uma escolha, não um esquecimento, e
está medido: as duas rotas de controle continuam sem header exatamente para que
a diferença fique visível.

Se um dia a decisão for cobrir tudo, o caminho é uma camada, e a decisão sobre
camada precisa ser tomada com o impacto mapeado — não de passagem.

---

## 36. Pendências antes da 5.5

1. **Publicar o código** (§1) — sem isso, nenhuma das correções da Fase 5 vale
   para quem usa a Helo.
2. **Executar a migração do R-04**, depois do deploy e com autorização (§32).
3. **Preencher o checklist do painel** — destrava R-12, A-11, o webhook e a
   decisão sobre `patientName`/`activePatientId`.
4. **Medir a sobreposição do Hosting** com a sonda da §11, depois do deploy.
5. **Aplicar a política de TTL** da coleção `rateLimits` (§9), se e quando fizer
   sentido operacionalmente.
