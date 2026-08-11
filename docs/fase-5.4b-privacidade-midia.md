# Fase 5.4B — Privacidade de mídia, Storage privado, R-04 e R-07

## 1. Resumo executivo

A 5.4A encontrou o R-04 como risco **ALTO**: o áudio pré-sintetizado de uma
frase favorita — a **voz clonada do paciente**, dizendo uma frase dele — era
publicado por `getDownloadURL`. Aquele endereço funciona por posse do token:
sem sessão, sem vínculo com o paciente, sem prazo, e continua funcionando
depois de o cuidador perder o acesso. Era o caminho que contornava inteiro o
portão de SpeechGrant erguido na 5.1A.

**Ele está fechado no código.** `getDownloadURL` não existe mais em lugar
nenhum do produto — nem para frase, nem para música. O objeto vive no Storage
sem URL; o documento guarda só o caminho; quem entrega os bytes é uma rota do
Next que pergunta *quem é você, e você alcança este paciente*.

Junto foram fechados **R-04b** (órfão no ciclo de re-síntese), **R-07a** (o
prompt do cuidador no log do servidor), **R-07b** (o corpo bruto da recusa do
provedor), **R-14** (a URL durável voltando à ElevenLabs no resultado da tool) e
**A-12** (música em namespace global). As **Storage Rules** entraram no
repositório e são exercitadas contra o emulador.

**A pendência, dita sem eufemismo:** a correção do código não alcança as URLs
que já saíram. O script de migração existe, é idempotente, tem dry-run por
padrão e foi provado ponta a ponta no emulador — **mas não foi executado em
produção**, porque esta fase não altera produção. Enquanto isso não acontecer:

> **R-04 no código = FECHADO.
> R-04 nos dados de produção = PREPARADO, NÃO EXECUTADO.**

Isso precisa ser resolvido antes do encerramento da Fase 5. Ver §20–22 e
`docs/migracao-midia-privada-5.4b.md`.

Nenhuma condição de parada da §71 foi encontrada.

---

## 2. Baseline 5.4A

| Item | Valor |
| --- | --- |
| HEAD/origin no início | `29dbb322b82a0e476f03e8f3ab2e8a85097de776` |
| Tag no HEAD | `ponto-seguranca-fase-5.4a` |
| Actions | 47 — navigation 9, operational 16, sensitive 12, patientResponse 10 |
| Agent-executable | 25 |
| lint | 55 erros / 6 warnings |
| Playwright | 282/282, 18 lotes |

Nada disso mudou. A 5.4B não criou action, não reclassificou nenhuma, não tocou
em autoria, transcript, STT nem SpeechGrant.

---

## 3. A decisão que veio pronta: a pré-síntese fica

O escopo da fase decidiu antes do código: **a pré-síntese de frases favoritas é
mantida**. Não se volta a sintetizar a cada reprodução.

Isso descarta a solução mais simples possível — apagar a Function e deixar só o
caminho do grant — e mantém a que preserva a latência. O problema a eliminar não
era a persistência: era

```
getDownloadURL  +  download token durável  +  acesso fora da Helo.
```

O modelo pedido, e implementado:

```
frase favorita → síntese → Storage PRIVADO → referência interna
              → endpoint autenticado → requirePatientAccess → bytes
```

---

## 4. R-04 — como era

```
POST /synthesizePhraseAudio  (Cloud Function, cookie __session, createActivities)
   ├─ ElevenLabs TTS na voz clonada do paciente
   ├─ Storage: patients/{pid}/phrases_audio/{phraseId}.mp3
   │           cacheControl: public, max-age=31536000, immutable
   ├─ getDownloadURL(file)          ← token durável embutido
   └─ Firestore: favoritePhrases/{id}.audioUrl = <URL pública>

reprodução:
   phrase.audioUrl → new Audio(url)
   o navegador busca em firebasestorage.googleapis.com
   SEM cookie · SEM sessão · SEM grant · SEM passar pela Helo
```

Dezoito perguntas foram respondidas na 5.4A §6. As que doíam:

- a URL funcionava sem autenticação (**sim**);
- não expirava (**não**);
- não era invalidada ao trocar o clone (**não**);
- não acompanhava a perda de vínculo (**não**);
- era servida com `immutable` por um ano (**sim**);
- e dispensava o SpeechGrant (**sim**).

### Por que Storage Rules não resolviam

Um Firebase download token é uma *capability*: ele existe **para** entregar o
objeto a quem não está autenticado, e por isso **passa por cima das Rules**.
Endurecer `storage.rules` — que esta fase também faz — protege o acesso direto
pelo SDK do cliente e não encosta na URL com token.

A correção tinha de ser outra: **parar de emitir o token**.

---

## 5. R-04 — como ficou

```
POST /synthesizePhraseAudio
   ├─ ElevenLabs TTS
   ├─ audioId opaco (12 bytes aleatórios)
   ├─ Storage: patients/{pid}/phrase-audio/{phraseId}/{audioId}.mp3
   │           cacheControl: private, no-store
   │           metadata: heloResource, heloPatientId, heloPhraseId
   ├─ Firestore: audioStoragePath = <caminho>   (audioUrl é DELETADO)
   └─ resposta: { ok: true }                    ← sem endereço nenhum

reprodução:
   phrase.hasAudio  (booleano)
   → GET /api/favorite-phrases/audio?patientId=&phraseId=
      requirePatientAccess(patientId, "viewActivities")
      servidor resolve o caminho a partir do id
      streaming com Range · private, no-store
```

**Uso final de `getDownloadURL` no produto: nenhum.** Congelado em teste
(`test:midia:privada` §1 e `test:5.4a:superficie` §4) junto com `getSignedUrl`,
`makePublic` e `firebaseStorageDownloadTokens` — porque trocar um mecanismo de
URL pública por outro não seria correção.

---

## 6. Autorização de mídia

A régua é a mesma dos dois endpoints novos:

| Camada | O que ela responde |
| --- | --- |
| `requirePatientAccess(patientId, permissão)` | usuário autenticado **e** com vínculo ativo com ESTE paciente, agora |
| o documento vive sob o paciente | o recurso pertence estruturalmente àquele paciente |
| `caminhoDeFraseEhValido` / `caminhoDeMusicaEhValido` | o caminho guardado está no namespace daquele paciente |

Nunca, em nenhum ponto:

- "possui `storagePath`" → pode baixar;
- "possui URL" → pode baixar.

A autorização é sempre uma pergunta feita ao servidor **no momento do acesso**,
contra o vínculo que vale naquele momento. É por isso que revogar o vínculo
corta o acesso na requisição seguinte (§18).

---

## 7. A referência persistida

| Campo | Onde | O que é |
| --- | --- | --- |
| `audioStoragePath` | `favoritePhrases/{id}` | caminho interno do objeto atual |
| `audioId` | `favoritePhrases/{id}` | o id opaco da geração atual |
| `storagePath` | `playlist/{id}` | caminho interno da faixa |
| `hasAudio` | **só na resposta da API** | booleano derivado; não existe no banco |

Os requisitos da §6 do escopo, um a um:

- **não contém bearer token** — é um caminho, não um endereço;
- **não concede acesso por si só** — o acesso vem do vínculo, verificado a cada
  requisição;
- **associa o objeto ao paciente correto** — o vínculo é estrutural no caminho;
- **permite ao servidor localizar o arquivo** — é o próprio caminho;
- **não depende de URL pública** — nenhuma é gerada;
- **pode ser validada** — e é, contra o namespace do paciente.

O que o **cliente** recebe é `hasAudio: boolean`. Ele diz se vale a pena pedir os
bytes; não diz onde eles estão, porque o cliente não precisa saber e não deve
poder contar a ninguém.

---

## 8. O caminho no Storage

```
patients/{patientId}/phrase-audio/{phraseId}/{audioIdOpaco}.mp3
patients/{patientId}/musics/{docId}.mp3
```

| Requisito | Como |
| --- | --- |
| vínculo explícito com o paciente | primeiro segmento depois de `patients/` |
| id não derivado de relógio | `randomBytes(12).toString("hex")` para a frase; o id do documento Firestore para a música |
| sem namespace global ambíguo | `musics/` foi abandonado (A-12) |
| sem path controlado por texto do usuário | nenhum segmento vem de campo preenchido |
| sem path traversal | o caminho nunca vem de fora; e ainda assim é validado |
| sem conteúdo clínico no nome | nem texto, nem gênero, nem título, nem horário |

O **prefixo por frase** não é decoração: é o que torna a limpeza auto-corretiva
(§15) e o que permite varrer gerações antigas sem manter uma lista.

---

## 9. Metadata do objeto

```
contentType : audio/mpeg
cacheControl: private, no-store            (frase)
              private, max-age=0, must-revalidate   (música)
metadata    : heloResource   = patientPhraseAudio | patientMusic
              heloPatientId  = <id>
              heloPhraseId   = <id>       (só na frase)
```

**Não entra**: texto da frase, nome do paciente, e-mail, SpeechGrant, chave da
ElevenLabs, `voiceId` do clone, diagnóstico, prompt da música, título.

O `cacheControl` no objeto existe mesmo o objeto não sendo servido pelo Storage:
é uma segunda linha, para o caso de ele ser lido por outro caminho um dia. Quem
decide o que o navegador vê é a rota (§11).

---

## 10. `/api/media` — reauditado antes de reutilizado

O escopo mandou não presumir, e a auditoria encontrou o motivo:

> **`/api/media` não usa Firebase Storage.** Ele guarda as imagens como base64,
> em chunks, dentro do Firestore (`patients/{id}/media/{id}/chunks/*`).

| Item | Estado |
| --- | --- |
| autenticação | cookie de sessão |
| `requirePatientAccess` | **sim**, com permissão para gerir |
| como o objeto é localizado | `patientId` + id opaco do documento |
| path arbitrário | **impossível** — não existe path |
| path traversal | **impossível** pelo mesmo motivo |
| Content-Type | do registro, validado contra allowlist na escrita |
| tamanho | 2,5 MB |
| streaming | **não** — buffer inteiro em memória |
| Range | **não** |
| Cache-Control | `private, max-age=3600` |
| exposição de erro | mensagens do próprio domínio |

**Conclusão: é o modelo de AUTORIZAÇÃO certo e o modelo de ARMAZENAMENTO
errado** para áudio. Uma música pode ter megabytes; carregá-la inteira na
memória de um runtime de 512 MiB para repassá-la seria trocar uma URL pública
por um gargalo, e chunks no Firestore seriam pior ainda.

O que foi reaproveitado: o **endereçamento por `patientId` + id opaco, com o
servidor resolvendo o caminho**. O que foi especializado: streaming com `Range`,
`no-store` para a voz clonada, e `nosniff`.

---

## 11. Cache-Control pretendido

| Resposta | Política | Por quê |
| --- | --- | --- |
| `/api/favorite-phrases/audio` | `private, no-store` | é a voz clonada do paciente — o dado mais sensível que o Helo produz. O custo é uma requisição por reprodução, e o áudio já está pré-sintetizado, que era exatamente o motivo de mantê-lo assim |
| `/api/patients/{id}/playlist/audio` | `private, max-age=0, must-revalidate` | `private` mantém fora de cache compartilhado; a revalidação obrigatória mantém o controle de acesso vivo a cada uso. O navegador **pode** guardar a cópia: a faixa tem megabytes e a barra de progresso pede pedaços o tempo todo — `no-store` transformaria cada arrasto do cursor numa nova descida |
| objeto no Storage | `private, no-store` / `private, max-age=0` | segunda linha, não a principal |

A diferença entre as duas rotas é **sobre tamanho de arquivo, não sobre sigilo**.

> **A 5.4A encontrou que o Firebase Hosting pode sobrepor headers em produção**
> (`{"source": "**", "headers": [{"Cache-Control": "no-cache"}]}`). Isso será
> **medido na 5.4C**. Esta fase define a intenção da rota e a prova localmente —
> `test:midia:autorizacao` confere o `no-store` que a rota emite. **Nada aqui
> afirma o comportamento do Hosting em produção.**

---

## 12. SpeechGrant — intacto

Nada foi alterado. `test:voice:authorization` continua **32/32**, incluindo
"rascunho arbitrário na voz do paciente é recusado" e "o mesmo grant não empresta
autoridade a outro texto".

A fronteira depois da 5.4B, dita com precisão:

| Operação | O que ela exige |
| --- | --- |
| **sintetizar** a fala do paciente (texto → voz) | autenticação + vínculo + **SpeechGrant** |
| **reproduzir** mídia já legitimamente criada | autenticação + vínculo |

Pedir grant de novo a cada playback não protegeria nada — a autorização de
autoria já aconteceu quando a frase foi salva e sintetizada. O que a 5.4B fechou
não foi a falta de grant no playback: foi o **playback anônimo**.

---

## 13. Ciclo de vida — criação

```
1. POST /api/favorite-phrases        → documento válido, sem áudio (hasAudio: false)
2. POST /synthesizePhraseAudio       → objeto privado + referência
```

O passo 1 já entrega um recurso completo: a frase existe, aparece na lista, e é
ouvida pelo caminho do grant. O passo 2 é otimização.

Se o passo 2 falhar, o resultado é **falha limpa**: documento sem
`audioStoragePath`, nenhum objeto órfão (nenhum foi criado), nenhuma URL
persistida, nenhum token. A tela diz que o áudio será preparado na próxima vez.

---

## 14. Re-síntese — o núcleo do R-04b

A ordem, na Function:

```
1. audioId novo, caminho novo             ← o anterior não é tocado
2. file.save(...)                          ← o objeto novo nasce
3. phraseRef.set({ audioStoragePath })     ← a referência troca
   └─ se falhar: file.delete() na hora     ← o novo é o único que ninguém alcança
4. varrePrefixoDaFrase(preservando o atual)
5. remove a geração anterior fora do prefixo (o caminho legado)
```

Os invariantes exigidos, e como cada um é garantido:

| Invariante | Garantia |
| --- | --- |
| nenhum documento quebrado | a referência só troca depois de o objeto existir |
| nenhum objeto novo órfão por falha previsível | o `catch` do passo 3 apaga o novo |
| a mídia antiga não some antes de a nova estar pronta | o passo 4 vem depois do 3 |
| nenhuma URL pública | não existe caminho que gere uma |

### A inversão deliberada, na edição de texto

O princípio geral é "preserve a mídia antiga até a nova estar pronta". Ele vale
para uma **re-síntese do mesmo texto** — e é assim que a Function trabalha.

Para uma **edição de texto**, seguir o mesmo princípio manteria tocável um áudio
que diz outra coisa. A mídia antiga não é "a versão anterior": ela é, por
construção, **a frase errada, na voz do paciente**. Preservá-la seria preservar
um defeito.

Então `updateFavoritePhrase` limpa a referência e descarta a mídia. Os quatro
invariantes acima continuam de pé: nenhum documento fica apontando para nada,
nenhum objeto novo nasce (nenhum nasce ali), e o que a limpeza não conseguir
apagar sai na varredura da próxima síntese daquela mesma frase.

---

## 15. Prevenção de órfãos — e por que não há fila

Apagar é sempre **best-effort**, e a palavra tem consequência: uma falha do
Storage não pode derrubar a operação que a pediu. Perder a chance de remover um
arquivo antigo é um resíduo; perder a referência do arquivo novo por causa disso
seria perder a mídia.

| Caminho | Classificação |
| --- | --- |
| gravar o objeto novo | **CRITICAL PATH** |
| trocar a referência no documento | **CRITICAL PATH** |
| apagar o objeto novo quando a troca falha | **CRITICAL PATH** |
| varrer gerações antigas | **BEST-EFFORT** |
| apagar o caminho legado | **BEST-EFFORT** |
| apagar a mídia na exclusão da frase | **BEST-EFFORT**, mas antes do documento |

O resíduo **não precisa de fila nem de job**, e essa foi uma decisão explícita
(o escopo §17 manda parar e reportar se cleanup confiável exigir infraestrutura
nova — não exigiu). O motivo: o caminho de cada frase é um **prefixo**, e toda
síntese varre o prefixo dela. O que escapou hoje sai na próxima síntese daquela
frase. **A limpeza se conserta sozinha.**

E um resíduo é detectável por definição: é tudo que sobra sob
`patients/{id}/phrase-audio/{phraseId}/` além do arquivo referenciado.

### Best-effort precisa de relógio — e a regressão provou isso

A limpeza roda **dentro** da requisição do cuidador. É o que garante a ordem
(a mídia sai antes do documento), e a primeira versão parou nisso — o que foi um
erro. A regressão dirigida o encontrou: *"editar uma frase salva"* estourou 90 s
esperando o PATCH responder, porque o ambiente de E2E não tem credencial de
Storage nenhuma e a varredura ficava pendurada.

O defeito **não era do teste**. O mesmo caminho, com o Storage lento em
produção, penduraria um cuidador de verdade — e ele perderia a edição por causa
de uma faxina.

Duas correções, as duas valendo em produção:

1. **a limpeza nem começa quando não há mídia.** A esmagadora maioria das frases
   nunca foi pré-sintetizada, e varrer um prefixo vazio custa uma ida à rede que
   não tinha o que limpar. A **exclusão** varre de qualquer forma: é rara, é
   final, e é a última chance de alcançar um resíduo de uma limpeza anterior
   malsucedida;
2. **toda limpeza tem prazo** (`PRAZO_DE_LIMPEZA_MS`, 5 s). Passado o prazo,
   segue-se em frente — o resíduo é o mesmo que qualquer outra falha produz, e
   some pelo mesmo caminho auto-corretivo.

---

## 16. Exclusão da frase

```
deleteFavoritePhrase:
   1. descartaMidiaDaFrase(...)   ← prefixo inteiro + caminho legado
   2. ref.delete()
```

A limpeza vem **antes** da exclusão do documento, e a ordem é a razão: se ela
falhar, o documento ainda existe e a próxima tentativa alcança o arquivo. Apagar
o documento primeiro seria perder o único ponteiro para um MP3 na voz do
paciente.

Se o Storage falhar, nenhuma URL pública vaza (não há nenhuma) e o log leva
apenas um código técnico.

Isto fecha um defeito concreto que a 5.4A tinha encontrado: no schema antigo, um
PATCH seguido de re-síntese falha zerava `storagePath`, e a exclusão posterior
**não** removia o MP3 — que sobrevivia à exclusão da frase, com o texto antigo,
na voz da pessoa.

---

## 17. Troca de clone e de fonte de voz

Três pontos passaram a invalidar o áudio pré-sintetizado:

| Ação | Rota |
| --- | --- |
| atribuir/substituir o clone | `POST /api/admin/patient-voice` |
| remover o clone | `DELETE /api/admin/patient-voice` |
| trocar a fonte (clone ↔ catálogo) | `POST /api/patient-voice-source` |

**A política é invalidar**, e é a mais simples que é coerente com o produto:

- não **regenerar** — seria trabalho pago sem ninguém ter pedido;
- não **marcar como desatualizado** — seria um estado novo na interface;
- não **deixar tocando** — seria a voz errada dizendo a frase certa.

Sem áudio pronto, a tela cai no caminho que já existia: pede o grant e sintetiza
na hora, com a voz que vale **agora**. Nenhuma UX nova, nenhum aviso novo,
nenhuma decisão para o cuidador tomar.

A auditoria registra o número de frases invalidadas (`audiosInvalidados`) —
número, nunca texto.

---

## 18. Perda de vínculo

| Momento | Resultado |
| --- | --- |
| com vínculo | **200**, com os bytes |
| depois de revogado | **403/404**, sem um byte |
| o arquivo | **continua existindo** |

O arquivo não é apagado de propósito: **o recurso é do paciente, não do
vínculo**. Outro cuidador legitimamente vinculado continua ouvindo. O requisito
é controle de acesso atual, não destruição.

Provado em `test:midia:autorizacao` §9 — antes e depois da revogação, com o
objeto real no bucket.

---

## 19. Cross-patient

Duas variantes, porque um ataque tentaria as duas:

| Tentativa | Resultado |
| --- | --- |
| frase do paciente **B**, informando `patientId` = **A** (o que o cuidador alcança) | **404** — o documento não existe sob A |
| frase do paciente **B**, informando `patientId` = **B** | **403** — sem vínculo |
| travessia no `phraseId` (`../../8/phrase-audio/x`) | **400** |
| caminho completo no `phraseId` | **400** |
| parâmetro `path` extra na query | **ignorado**; a rota responde pelo id |
| `patientId` não numérico | **400** |

Em nenhum caso o `Content-Type` é `audio/*`.

---

## 20. Legado

O schema antigo, e o que acontece com ele **agora**:

| Situação | Leitura | URL pública |
| --- | --- | --- |
| frase com `storagePath` legado (`phrases_audio/`) | **funciona** pela rota autenticada | ainda viva no bucket |
| frase só com `audioUrl` | não toca (cai no grant) | ainda viva |
| música com `storagePath` legado (`musics/`) | **funciona** pela rota autenticada | ainda viva |
| música só com `audioUrl` | **funciona** — o caminho é lido de dentro da URL | ainda viva |

Ler o legado pela rota nova é deliberado: o documento já vive sob o paciente, e
recusar só tiraria o áudio de quem tem direito a ele — **sem tirar nada de quem
tem a URL antiga**.

**O navegador não recebe mais nenhuma URL pública, nem para conteúdo legado.** O
tipo `FavoritePhrase` não tem o campo, e `PatientPlaylistTrack` também não. Isso
vale desde o primeiro instante, sem esperar migração.

O que a migração faz — e só ela — é **matar a URL antiga**.

---

## 21. O script de migração

`scripts/migrar-midia-privada.mjs`, documentado em
`docs/migracao-midia-privada-5.4b.md`.

- **dry-run por padrão**; `--apply` explícito;
- recusa execução ambígua: sem emulador e sem `--producao`; `--producao` sem
  `--confirmo-projeto <id exato>`; `--producao` **com** emulador definido;
- **idempotente e retomável**;
- **não imprime** texto de frase, prompt, título, nome nem download token;
- ordem: copia → confere → corrige o `cacheControl` herdado → aponta o documento
  → **só então** apaga o legado;
- um item que falha fica **intocado** e é contado.

### Por que copiar e apagar, em vez de "remover o token"

O escopo §25 foi explícito, e a razão vale repetir: o projeto não tem como
comprovar o comportamento interno do Firebase ao remover
`firebaseStorageDownloadTokens`. **Apagar o objeto é verificável** — a URL antiga
apontava para um arquivo que não está mais no bucket, e isso é observável.

`test:migracao:midia` §4 faz exatamente essa observação no emulador.

---

## 22. Status da migração de produção

> **LEGADO DE PRODUÇÃO AINDA PRECISA SER MIGRADO.**

Não sabemos quantos documentos existem — esta fase não acessou produção e não
deveria. O que existe é o mecanismo, provado em ambiente descartável.

Enquanto o script não rodar contra produção:

- toda `audioUrl` já gravada continua entregando o arquivo a quem tiver o link;
- e continua fazendo isso depois de o cuidador perder o vínculo.

**Esta pendência precisa ser resolvida antes do encerramento da Fase 5.**

---

## 23. Storage Rules

Versionadas em `storage.rules` e ligadas em `firebase.json` **e**
`firebase.test.json`.

Elas **não** são a correção do R-04, e o próprio arquivo diz isso na primeira
seção de comentário. São a tranca do lado que sobrou: o acesso direto do cliente
ao bucket.

**Por que negar tudo não quebra nada** — verificado antes de escrito, não
presumido: o Helo **não tem o SDK cliente do Firebase**. `package.json` traz
`firebase-admin` e mais nada da família; não existe uma linha no navegador capaz
de chamar o Storage. O acesso do cliente era por URL com token, que acabou. Quem
lê e escreve é o Admin SDK, no servidor e nas Functions — e ele **não passa pelas
regras**.

Os caminhos sensíveis (`phrase-audio`, `phrases_audio`, `musics` sob o paciente
e o `musics/` global legado) são nomeados **antes** da regra geral. Não porque a
regra geral não bastasse: para que a proibição seja **legível**. Quem abrir o
arquivo perguntando "o áudio do paciente está protegido?" encontra a resposta
escrita, em vez de deduzi-la de um curinga.

---

## 24. Testes das Storage Rules

`test:storage:rules` — **17 asserções**, contra o emulador de verdade, não
contra o texto do arquivo.

| Prova | Resultado |
| --- | --- |
| anônimo lê `phrase-audio` | **403** |
| anônimo lê `phrases_audio` (legado) | **403** |
| anônimo lê música sob o paciente | **403** |
| anônimo lê `musics/` global | **403** |
| anônimo lê qualquer outro caminho | **403** |
| caminho **inexistente** | **403** — a diferença entre 403 e 404 não revela o bucket |
| caminho de outro paciente | **403** |
| cliente escreve (três caminhos) | **403** |
| Admin SDK lê e apaga | **funciona** |

A última linha é a que prova que fechar não quebrou o produto.

Infraestrutura: `firebase.test.json` ganhou o emulador de Storage na **9199**, e
portas próprias de **hub (4410)** e **logging (4510)** — sem elas, a instância
que sobe só o Storage colide com a que já estiver rodando.

---

## 25. R-07a — o prompt da música

**FECHADO.** Era:

```js
console.log("Received music payload:", { prompt: req.body?.prompt, genre, durationSeconds });
```

O prompt é criativo por natureza ("algo calmo para dormir"), mas é ditado em voz
alta numa sessão clínica, sobre uma pessoa, e nada impede que saia como "uma
música para a Maria, que está agitada desde a internação".

Ficou:

```js
console.log("[HELO MUSIC] pedido recebido", {
  caracteresNoPrompt: prompt.length,
  generoInformado: Boolean(genre),
  durationSeconds,
});
```

Medida, não conteúdo. **Nem recorte, nem hash** — os dois continuam sendo o
conteúdo, só que mais difícil.

A verificação é exaustiva: `test:midia:privada` §11 extrai os argumentos de cada
`console.*` por contagem de parênteses e permite exatamente duas formas
(`prompt.length` e `Boolean(genre)`). Qualquer outra menção ao pedido do cuidador
dentro de um log reprova.

---

## 26. R-07b — o corpo bruto do provedor

**FECHADO.** Era a única ocorrência de `response.text()` em todo o produto:

```js
const responseText = await elevenLabsResponse.text();
console.error(..., { status, response: responseText.slice(0, 500) });
```

O corpo de uma recusa da ElevenLabs ecoa o que foi enviado — ou seja, o prompt de
volta.

Ficou:

```js
console.error("[HELO MUSIC] provedor recusou a composição", {
  provider: "elevenlabs",
  operation: "generateMusic",
  httpStatus: elevenLabsResponse.status,
  errorCode: "MUSIC_PROVIDER_REJECTED",
});
```

**O corpo não é sequer lido.** Não adianta ler e não registrar: a próxima pessoa
que passar por ali registra "só desta vez".

O cliente recebe `{ error, code: "MUSIC_GENERATION_FAILED" }` — código estável,
nada do provedor. O `catch` final também deixou de despejar o objeto de erro.

E do lado do navegador, a mensagem narrada ao Agent passou a ser **sempre escrita
pela Helo**: um erro de rede virava "Failed to fetch" na voz da Helo e na
transcrição do provedor.

---

## 27. R-14 — a URL no resultado da tool

**FECHADO.**

```
antes:  return { ok, audioUrl, title, outcome, message }   → ElevenLabs
depois: return { ok,           title, outcome, message }   → ElevenLabs
```

Nem `trackId` entra: o Agent não tem o que fazer com um identificador de arquivo,
e o que não é enviado não precisa ser protegido do outro lado.

O navegador continua tocando: `playMusicTrack` recebe `trackId` + `patientId` e
monta o endereço **interno**. E como não existe mais URL nenhuma naquele objeto,
não existe URL para vazar.

`play_existing_music` já não devolvia endereço, e continua assim.

Congelado em `test:midia:privada` §12: o bloco de retorno de sucesso é extraído
e conferido contra `trackId|storagePath|audioUrl|http`.

---

## 28. A-12 — música sob o paciente

**FECHADO.**

```
antes:  musics/{Date.now()}-{genero}.mp3     ← global, sem paciente, nome do relógio
depois: patients/{patientId}/musics/{docId}.mp3
```

O id do documento nasce **antes** do arquivo (`collection.doc()` em vez de
`.add()`), e é o mesmo dos dois lados. O caminho carrega o vínculo, e o nome não
conta nada — nem gênero, nem horário, nem uma letra do que foi pedido.

O documento também deixou de guardar `audioUrl`.

---

## 29. Fluxo final da música

```
cuidador pede música por voz
  → Agent chama generate_and_play_music
  → POST /generateMusic  (cookie, createSession)
       ├─ log: medida, não conteúdo
       ├─ ElevenLabs /v1/music
       ├─ Storage: patients/{id}/musics/{docId}.mp3   private
       ├─ Firestore: playlist/{docId}.storagePath
       └─ resposta: { trackId, title, createdAt, period }
  → navegador: GET /api/patients/{id}/playlist/audio?id={docId}
       requirePatientAccess(viewMetrics) · streaming com Range
  → tool result → ElevenLabs: { ok, title, outcome, message }
```

**Nenhum link público em nenhum ponto.** A funcionalidade não mudou: o cuidador
pede, a música toca, a barra de progresso funciona (é para isso que o `Range`
existe), e a playlist continua listando o histórico.

Música **não é** voz clonada e não foi tratada como se fosse: não pede
SpeechGrant e tem política de cache própria. Mas é personalizada, associada ao
paciente e derivada de um pedido do cuidador — então também não é pública.

---

## 30. Dados devolvidos ao Agent

| Tool | O que volta |
| --- | --- |
| `generate_and_play_music` | `ok`, `title`, `outcome`, `message` |
| `play_existing_music` | `ok`, `found`, `title`, `period`, `outcome` |
| `getCurrentHeloActions` | tela, capacidades, `humanOnly` — inalterado |
| `interactWithHeloUI` | resultado do dispatcher — inalterado |

**R-09 permanece fechado**: nenhuma mudança desta fase recolocou `patientId`,
texto clínico, `audioUrl`, `storagePath`, DOM ou pergunta clínica no payload do
Agent. `test:agent:inventory` (42) e `test:agent:capabilities` (47) seguem
verdes.

**R-08 permanece fechado**: autoria, roles e transcript não foram tocados.

---

## 31. `patientName` e `activePatientId`

Auditados, **não removidos**. O contrato do painel ElevenLabs continua não
verificado, e o escopo §40 foi explícito: não quebrar o Agent por uma otimização
não comprovada.

| Variável | Classificação |
| --- | --- |
| `preferredName` | **NECESSÁRIO** — é o nome de tratamento, e a saudação depende dele |
| `patientName` | **DESNECESSÁRIO LOCALMENTE, MAS CONTRATO EXTERNO NÃO VERIFICADO** — `preferredName` cobre o uso do lado de cá; o System Prompt pode referenciá-lo |
| `activePatientId` | **DESNECESSÁRIO LOCALMENTE, MAS CONTRATO EXTERNO NÃO VERIFICADO** — nenhum caminho do Helo o aceita de volta; o gate ignora qualquer `patientId` vindo do Agent |
| demais 9 | **NECESSÁRIO** ou configuracional |

Decisão adiada para a **5.4C**, depois do checklist do painel
(`docs/elevenlabs-agent-contract-checklist.md` §6).

---

## 32. Testes

### Novos — 183 asserções

| Suíte | Asserções | O que ela responde |
| --- | --- | --- |
| `test:midia:privada` | **94** | estrutural, rodando o código de produção: nenhuma URL pública é emitida; o caminho carrega o paciente e não carrega conteúdo; um caminho estragado não vira leitura de outro lugar; nenhuma rota aceita caminho do navegador; a aritmética do `Range`; a ordem que impede o órfão; o prazo da limpeza; e o que a fase não podia tocar |
| `test:midia:autorizacao` | **35** | HTTP — a prova central do R-04 |
| `test:storage:rules` | **17** | comportamento das regras contra o emulador |
| `test:migracao:midia` | **40** | dry-run, apply, morte da URL legada, idempotência, guardas |

### As 18 provas exigidas pelo escopo §47

| # | Prova | Onde |
| --- | --- | --- |
| 1 | criação não gera download URL | `midia:privada` §1 |
| 2 | documento novo não salva `audioUrl` público | `midia:privada` §1; `midia:autorizacao` §1 |
| 3 | usuário autorizado reproduz | `midia:autorizacao` §7 |
| 4 | anônimo não reproduz | `midia:autorizacao` §2 e §8 |
| 5 | cuidador sem vínculo não reproduz | `midia:autorizacao` §3 |
| 6 | A não reproduz mídia de B | `midia:autorizacao` §4 |
| 7 | path arbitrário falha | `midia:autorizacao` §5; `midia:privada` §3–4 |
| 8 | re-síntese preserva a mídia antiga até a nova ficar pronta | `midia:privada` §7 |
| 9 | falha antes do update não deixa referência quebrada | `midia:privada` §7 |
| 10 | falha do update limpa o objeto novo | `midia:privada` §7 |
| 11 | delete da frase limpa a mídia | `midia:privada` §8 |
| 12 | troca de clone invalida a mídia antiga | `midia:privada` §8 |
| 13 | prompt de música não aparece em logs | `midia:privada` §11 |
| 14 | corpo bruto do provedor não aparece | `midia:privada` §11 |
| 15 | Agent não recebe `audioUrl` | `midia:privada` §12 |
| 16 | música nova em namespace do paciente | `midia:privada` §2 e §12; Function |
| 17 | Rules negam acesso direto do cliente | `storage:rules` §1–5 |
| 18 | SpeechGrant intacto | `voice:authorization` (32); `midia:privada` §14 |

### §48 — o teste da URL copiada

A URL que o navegador usa é `/api/favorite-phrases/audio?patientId=&phraseId=`.
Copiada para uma sessão sem autenticação: **401**, com `Content-Type: application/json`
e nenhum byte do áudio — inclusive com o objeto realmente gravado no bucket
(`midia:autorizacao` §8). **Não existe mais nenhuma URL bearer durável.**

### §65 — os marcadores

O escopo pediu marcadores literais (`SEGREDO_R07_PROMPT_X7`,
`SEGREDO_R07_PROVIDER_BODY_X8`) num teste de fluxo. Foi implementado de forma
mais forte e sem chamar o provedor: em vez de mandar um marcador e conferir que
ele não aparece — o que prova apenas aquele caminho —, `test:midia:privada` §11
prova que **nenhum log carrega o valor do prompt**, em qualquer chamada do
arquivo, e que **o corpo do provedor não é sequer lido**. Um marcador que
escapasse por um `console.*` novo seria pego; um teste de marcador só pegaria o
caminho que ele exercitasse.

### Suítes existentes

| Suíte | Resultado |
| --- | --- |
| `test:voice:authorization` | 32 ✓ |
| `test:voice:grant` | 32 ✓ |
| `test:voice:callsites` | 14 ✓ |
| `test:agent:gate` | 53 ✓ |
| `test:agent:invariants` | 23 ✓ |
| `test:agent:inventory` | 42 ✓ |
| `test:agent:capabilities` | 47 ✓ |
| `test:agent:context` | 49 ✓ |
| `test:agent:stale` | 53 ✓ |
| `test:agent:authorship` | 36 ✓ |
| `test:agent:lifecycle` | 33 ✓ |
| `test:agent:teardown` | 12 ✓ |
| `test:music:authorization` | 17 ✓ |
| `test:audio:cache` | 42 ✓ |
| `test:audio:lifecycle` | 62 ✓ |
| `test:voice:cancel` | 58 ✓ |
| `test:voice:timeout` | 53 ✓ |
| `test:authorship` | 53 ✓ |
| `test:eleven-guard` | 46 ✓ |
| `test:5.4a:superficie` | 31 ✓ |

---

## 33. Regressão, tsc, build, lint

Preenchido em §34 do relatório de entrega. `tsc` limpo, `build` limpo, `lint` no
baseline **55 erros / 6 warnings** — os dois warnings que a fase introduziu
(imports não usados nos scripts novos) foram corrigidos.

**Zero chamadas reais à ElevenLabs.** O servidor de suítes sobe pela guarda de
`scripts/eleven-guard.mjs`, que imprime `provedor ElevenLabs: NEUTRALIZADO`.

---

## 34. Performance

A pré-síntese foi mantida justamente para preservar latência, e a solução não a
desfaz:

| Caminho | Antes | Depois |
| --- | --- | --- |
| frase com áudio pronto | 1 requisição ao Storage | 1 requisição ao Helo (que lê o Storage por streaming) |
| frase sem áudio | grant + TTS | **igual** |
| música | 1 requisição ao Storage | 1 requisição ao Helo, com `Range` |
| re-síntese | 1 síntese | **igual** |

O que a solução **não** faz, e foi verificado:

- não baixa o arquivo inteiro repetidamente — usa `createReadStream`, e com
  `Range` baixa só o trecho pedido;
- não duplica síntese — a Function é chamada uma vez, como antes;
- não re-sintetiza a cada play — `hasAudio` continua evitando isso;
- não carrega arquivos grandes inteiros em memória — o motivo de não copiar o
  modelo de `/api/media`.

O custo real acrescentado é **um salto de rede a mais por reprodução** (o
navegador fala com o Helo em vez de falar com o Storage) e **uma leitura de
metadata** por requisição, para saber o tamanho. Em troca, o áudio deixou de ser
público.

Do lado da escrita, a limpeza acrescentaria latência à edição e à exclusão de
frases — e acrescentou, até a regressão dirigida mostrar quanto (§15). Depois da
correção: **zero** chamadas ao Storage quando a frase nunca teve áudio, e no
máximo `PRAZO_DE_LIMPEZA_MS` quando teve.

Uma falha ao ler a metadata deixou de ser sempre 404: só o objeto ausente é 404,
e o transitório é 503. Um Storage lento reportado como "mídia não encontrada"
mandaria o cuidador desistir de uma frase que está lá.

---

## 35. Limitações

1. **A migração de produção não foi executada.** É a limitação principal, e ela
   tem seção própria (§22).
2. **O `Cache-Control` real em produção não foi medido.** O Hosting pode
   sobrepor; a 5.4C mede.
3. **O emulador de Storage não implementa listagem GCS igual à produção.** O
   `getFiles` usado pela varredura foi exercitado, mas a asserção de "não nasceu
   uma segunda cópia" é tolerante a isso.
4. **A Function não foi executada de verdade** — nenhuma chamada à ElevenLabs.
   O que foi provado é a estrutura do handler e o ciclo de vida do lado do
   Firestore/Storage.
5. **O comportamento sob carga não foi medido.** A ausência de rate limiting
   continua sendo o A-10, e continua sendo da 5.4C.
6. **O contrato do painel ElevenLabs continua não verificado**, e por isso
   `patientName`/`activePatientId` ficaram onde estavam.

---

## 36. Itens que seguem para a 5.4C

Nenhum deles foi absorvido:

- **A-10** — rate limiting;
- **A-10b** — `Cache-Control` nas demais rotas;
- **A-10c** — medição real do Hosting;
- **A-09** — logs residuais do Agent no navegador;
- **R-12** — override morto da voz do Agent;
- **A-11** — aliases legados de tool e de parâmetro;
- **A-13** — envs órfãs dependentes do painel;
- `/webhook/generate_music`;
- o contrato do painel ElevenLabs.

E um item novo, que a 5.4B cria e não resolve:

- **executar a migração do legado em produção** (§22). Não é 5.4C por natureza —
  é uma operação, não um hardening —, mas precisa acontecer antes do
  encerramento da Fase 5.
