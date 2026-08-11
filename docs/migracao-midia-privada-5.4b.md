# Migração da mídia legada para o modelo privado — Fase 5.4B

> **Este procedimento ainda NÃO foi executado em produção.** A Fase 5.4B
> entrega o código e a prova em ambiente descartável. A execução real é uma
> decisão à parte, e precisa acontecer antes do encerramento da Fase 5.

---

## 1. O que será migrado, e por quê

Corrigir o código fechou a porta para o que vem **depois**. Não fechou o que já
saiu.

Cada campo `audioUrl` gravado antes desta fase é um Firebase download URL: um
endereço com token embutido que entrega o arquivo a quem o tiver — sem sessão,
sem vínculo com o paciente, sem prazo. Nenhuma mudança em `functions/index.js`
alcança um link que já está no mundo, e nenhuma Storage Rule o bloqueia (o token
existe justamente para passar por cima delas).

**O que mata a URL antiga é apagar o objeto que ela aponta.** É a única forma
verificável: não depende de acreditar em como o Firebase trata tokens
internamente, depende de o arquivo não estar mais no bucket.

Dois conjuntos:

| Recurso | Onde está hoje | Para onde vai |
| --- | --- | --- |
| Áudio de frase favorita (**voz clonada do paciente**) | `patients/{id}/phrases_audio/{phraseId}.mp3` + `audioUrl` no documento | `patients/{id}/phrase-audio/{phraseId}/{idOpaco}.mp3` + `audioStoragePath` |
| Música da playlist | `musics/{timestamp}-{genero}.mp3` + `audioUrl` no documento | `patients/{id}/musics/{docId}.mp3` + `storagePath` |

A frase é a prioridade: é voz clonada identificável de uma pessoa. A música vem
junto porque é o mesmo mecanismo e o mesmo script.

## 2. Pré-condições

1. **O código da 5.4B está publicado** — o app Next **e** as Cloud Functions.
   Se a Function antiga ainda estiver no ar, ela volta a gravar `audioUrl` na
   próxima síntese, e a migração vira trabalho recorrente. O app pode ir antes
   sem risco (ele já não expõe URL nenhuma); a Function é que não pode ficar
   para trás.
2. **Um backup do bucket**, ou pelo menos a certeza de que existe versionamento
   de objetos. O script apaga arquivos.
3. **Credencial com acesso ao Firestore e ao Storage do projeto.** O script usa
   o Admin SDK por ADC — ele **não** aceita nem pede credencial em parâmetro.
4. **Janela tranquila.** Não há downtime, mas uma frase migrada enquanto alguém
   a ouve pode interromper aquela reprodução (o objeto muda de lugar).

## 3. Dry-run — sempre primeiro

```bash
node scripts/migrar-midia-privada.mjs --producao --confirmo-projeto helo-app-7fbf8
```

Sem `--apply`, **nada é alterado**. A saída traz apenas contagens e, por item, o
caminho de origem e o de destino. Ela **não** imprime texto de frase, prompt de
música, título, nome de paciente nem download token — isso é verificado por
teste (`test:migracao:midia` §2).

O que ler na saída:

| Linha | O que significa |
| --- | --- |
| `já privadas (nada a fazer)` | documentos que já estão no modelo novo |
| `a migrar` | o trabalho real |
| `sem objeto no Storage` | o documento aponta para um arquivo que não existe mais; o campo público sai e a frase volta a ser sintetizada na hora |
| `com falha (intocadas)` | **precisa investigar antes de seguir** |

## 4. Apply

```bash
node scripts/migrar-midia-privada.mjs --producao --confirmo-projeto helo-app-7fbf8 --apply
```

A guarda recusa três formas de execução ambígua, e cada recusa é testada:

- sem `FIRESTORE_EMULATOR_HOST` e sem `--producao` → recusa;
- `--producao` sem `--confirmo-projeto <id exato>` → recusa;
- `--producao` **com** `FIRESTORE_EMULATOR_HOST` definido → recusa (é
  contraditório).

## 5. A ordem, e o que ela garante

Por item:

1. copia o objeto legado para o caminho privado novo;
2. **confere que a cópia existe de verdade**;
3. corrige o `cacheControl` da cópia — o original é `public, max-age=31536000,
   immutable`, e a cópia herda a metadata; deixá-lo seria levar para o modelo
   novo justamente o cabeçalho que o modelo novo existe para não ter;
4. aponta o documento para a cópia e apaga `audioUrl` e o `storagePath` legado;
5. **só então** apaga o objeto legado.

Se qualquer passo falhar, o anterior continua válido:

- falha em 1 ou 2 → nada mudou; o item conta como `com falha` e é **intocado**;
- falha em 4 → sobra uma cópia não referenciada, que a próxima execução
  reaproveita (o passo 2 a encontra);
- falha em 5 → o documento já aponta para a cópia; o legado vira resíduo, e a
  próxima execução tenta de novo.

**Em nenhum momento existe um documento apontando para nada, e em nenhum momento
o original some antes de a cópia estar no lugar.**

## 6. Rollback

Não há rollback automático, e é importante dizer por quê: o passo irreversível é
justamente o objetivo — apagar o objeto legado é o que mata a URL pública.
Desfazer seria recriá-la.

O que existe:

- **antes do passo 5**, tudo é reversível: o objeto legado ainda está lá, e
  reverter é apagar o campo `audioStoragePath` do documento;
- **depois do passo 5**, o conteúdo não se perde — ele está na cópia privada,
  referenciada pelo documento. O que não volta é o endereço público;
- se um item ficar em estado ruim, o caminho de recuperação é **apagar
  `audioStoragePath`/`storagePath` do documento**: a frase passa a ser
  sintetizada na hora pelo caminho do SpeechGrant, sem perda funcional.

## 7. Como verificar que deu certo

1. **A contagem**: `com falha` = 0 e `a migrar` = 0 numa segunda execução em
   dry-run.
2. **Nenhum `audioUrl` sobrou**. No console do Firestore, procure o campo em
   `patients/*/favoritePhrases` e `patients/*/playlist`. Zero ocorrências.
3. **A URL antiga morreu.** Pegue uma URL que você tenha anotado antes e abra
   numa aba anônima: deve responder erro, não áudio. *(É exatamente esta
   verificação que `test:migracao:midia` §4 faz no emulador.)*
4. **O áudio continua tocando.** Abra "Frases para se ouvir" com um cuidador
   vinculado: a frase migrada toca pela rota autenticada.
5. **Nenhum objeto sobrou no lugar antigo.** `gsutil ls` em `musics/` e em
   `patients/*/phrases_audio/` deve vir vazio.

## 8. Como retomar

O script é **idempotente e retomável** por construção: ele percorre documento a
documento e reconhece o que já está no modelo novo (`test:migracao:midia` §7 e
§8). Uma execução interrompida no meio pode simplesmente ser repetida — a
segunda passagem ignora o que já foi feito, não duplica cópias e não apaga nada
que já tenha sido apagado.

## 9. Como exercitar antes, em ambiente descartável

```bash
npm run emu:test          # Firestore 8090 + Storage 9199 (terminal 1)
npm run test:migracao:midia
```

A suíte semeia documentos e objetos legados, roda o dry-run, roda o apply,
confere cada invariante e roda de novo para provar a idempotência. **40
asserções.**

## 10. Métricas para acompanhar

| Métrica | Onde | Esperado |
| --- | --- | --- |
| itens `a migrar` | saída do dry-run | cai a zero |
| itens `com falha` | saída do apply | zero |
| objetos em `musics/` | bucket | zero |
| objetos em `patients/*/phrases_audio/` | bucket | zero |
| documentos com `audioUrl` | Firestore | zero |
| 404 em `/api/favorite-phrases/audio` | log da aplicação | não deve subir |

---

**Nenhuma credencial aparece neste documento, e o script não aceita nenhuma por
parâmetro.** A autenticação é a ADC do ambiente de quem executa.
