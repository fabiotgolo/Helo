# Modelo de confiança da voz do paciente

Fase 5.1A · fechamento

Este documento existe para dizer, sem eufemismo, **o que o Helo prova e o que
ele não prova** quando a voz de um paciente fala. Ele não descreve uma
intenção futura: descreve o sistema como ele está.

---

## A afirmação, em uma frase

> Quando a voz do paciente diz alguma coisa, o Helo garante que **aquele texto
> exato veio de uma origem legítima do sistema** e que **nenhum componente
> automático o acionou**. Ele **não** garante — e não pode garantir — que a
> pessoa fez o gesto.

Tudo o mais neste documento é o detalhe dessa frase.

---

## Quem participa

| Papel | O que faz | O que o sistema sabe sobre ele |
|---|---|---|
| **Paciente** | Faz o gesto físico (olhar, polegar, punho, mão aberta) | Nada. O gesto acontece fora de qualquer sensor do Helo |
| **Acompanhante autorizado** | Observa o gesto e registra na tela | Está autenticado, tem vínculo ativo com este paciente e uma permissão declarada |
| **Servidor** | Deriva o texto, assina a autorização, sintetiza | Tudo o que assinou |
| **Agent Helo** | Conduz a conversa por voz | Que ele é um agente — e por isso o que ele pode acionar é restrito por classe |

---

## A cadeia, elo por elo

```
gesto físico  →  observação humana  →  clique  →  grant do servidor  →  voz
   (1)                 (2)              (3)            (4)             (5)
```

| Elo | O que é | Garantia |
|---|---|---|
| 1 | O paciente faz o gesto | **Nenhuma.** Fora do alcance do software |
| 2 | O acompanhante interpreta | **Nenhuma técnica.** É julgamento clínico humano |
| 3 | O clique registra a observação | Autenticação, vínculo com o paciente, permissão. Prova **quem** clicou, não **por quê** |
| 4 | O servidor emite o SpeechGrant | Prova **procedência**: este texto, este paciente, esta origem resolvida pelo servidor, dentro de 2 minutos |
| 5 | `/api/tts` sintetiza | Só com grant válido. Sem grant, sem voz do paciente |

**O elo frágil é o 1→2, e ele é humano por natureza.** Nenhuma tecnologia
disponível ao Helo hoje observa um gesto e atesta que ele ocorreu.

---

## O que cada mecanismo prova

### SpeechGrant (R-01) — prova de **procedência**

O cliente não envia o texto que quer falar. Ele **nomeia um recurso**
(`{ kind: "routineAnswer", questionKey, answer }`), e o servidor responde qual
é o texto daquele recurso e assina um grant para ele.

**Prova:** que este texto exato, para este paciente, saiu de uma origem que o
servidor sabe resolver e ainda está no prazo. Texto arbitrário na voz de
alguém: impossível.

**Não prova:** que um humano tocou a tela.

> Um grant **não é** prova de consentimento. Não o descreva assim em código,
> comentário, log ou conversa.

### Gate de classe (R-02) — prova de **origem não-automática**

Toda ação da interface declara uma `actionClass`. O Agent alcança apenas
`navigation` e `operational`; `patientResponse` e `sensitive` são recusadas, e
uma ação **sem** classe também (fail-closed). A decisão é tomada sobre o que a
ação **é**, nunca sobre como foi pedida — por isso ela sobrevive a sinônimo,
alias, emoji, idioma e ao actionId literal.

**Prova:** que o clique que originou a fala **não** veio de um componente
automático. O que resta como origem é uma pessoa na tela.

**Não prova:** qual pessoa, nem que ela observou corretamente.

### As duas metades juntas

| | O texto | O acionamento |
|---|---|---|
| **Fechado por** | SpeechGrant (R-01) | Gate de classe (R-02) |
| **Garantia** | Veio do servidor | Veio de um humano |

O que sobra descoberto é a **qualidade da observação humana** — e isso é uma
questão de cuidado, formação e responsabilidade profissional, não de
criptografia.

---

## A fronteira, dita sem rodeio

Esta é uma fronteira **humano-no-loop**. O acompanhante autorizado é parte do
sistema de confiança, não um usuário sendo verificado por ele.

O que isso significa na prática:

- Um acompanhante autorizado **pode** registrar um gesto que não aconteceu. O
  sistema aceitará, porque não tem como saber. O que ele deixa é rastro: quem
  registrou, quando, para qual paciente, sobre qual conteúdo.
- Nenhuma quantidade de criptografia muda isso. Assinar mais coisas, encurtar
  prazos ou exigir mais confirmações no cliente produziria **aparência** de
  prova, e aparência de prova é pior do que ausência dela: convida a confiar no
  que não sustenta.
- O caminho honesto para reduzir essa margem não é técnico-criptográfico. Seria
  um sensor que observa o gesto — e nesse dia a conversa muda de assunto, para
  falsos positivos, consentimento de captura de imagem e privacidade.

**Não construa uma "prova criptográfica de toque humano".** Ela não existe, e
tentar simulá-la trocaria uma limitação conhecida por uma falsa segurança.

---

## O que a 5.1A mudou de fato

**Conversa e Mensagem — a ordem foi invertida.** Antes, o registro
(`saveMessage`) e a fala corriam em paralelo: a voz podia sair sem que o
registro existisse. Agora registra-se primeiro, e o grant é emitido sobre o
texto **que acabou de ser gravado**.

Isso não fecha a fronteira acima. Fecha uma coisa menor e real: a voz do
paciente não sai antes de existir um registro autoritativo dela.

**Rotina, Atividades e Emergência não foram alteradas.** Esses fluxos não
persistem o gesto antes de falar. Mudar isso agora significaria inserir uma
escrita de banco entre o toque e a voz — e a Emergência é justamente onde essa
latência não pode existir. Mais importante: mesmo com a escrita, o servidor
continuaria sabendo apenas que *alguém autorizado escreveu*, que é o que ele já
sabe. Seria custo sem prova nova.

---

## Pendência conhecida — prévia de frase favorita

**Onde:** Atividades → Gerenciar → frases → "🔊 Ouvir"
([app/atividades/gerenciar/page.tsx](../app/atividades/gerenciar/page.tsx), `previewPhrase`)

O botão reproduz **o texto que o cuidador está digitando**, ainda não salvo, com
`speakerRole: "patient"`. É o caminho de texto livre na voz clonada que o R-01
existe para fechar, e não há grant possível para ele: rascunho não é origem, e
não deve virar uma.

**Estado hoje:** `/api/tts` recusa com 403. Nada é falado sem autorização — mas
o botão falha em silêncio, e o cuidador não recebe explicação.

Vale notar como isto passou: a auditoria 5.0 inventariou as **origens do
servidor**, e a 5.1A as implementou. Nenhuma das duas inventariou os **call
sites do cliente**, que são uma lista diferente. Duas telas ficaram para trás;
`app/admin` foi corrigida quando apareceu, esta ficou. Quem fecha essa
categoria agora é
[scripts/test-voice-call-sites.mjs](../scripts/test-voice-call-sites.mjs), que
varre o cliente inteiro e reprova qualquer caso novo.

**Decisão (2026-08-08):** deixar em aberto, tratar numa fase seguinte. Saídas
avaliadas:

| Saída | O que muda |
|---|---|
| Falar na voz da **plataforma** | O cuidador confere a redação, que é para o que o botão serve. A voz do paciente segue disponível para frases **salvas**, no modal "Frases para ouvir", que já pede grant |
| **Salvar antes** de ouvir | Mantém a voz do paciente, com origem `favoritePhrase`. Cria registro de frase que o cuidador ainda podia descartar |
| **Remover** o botão | A escuta fica só no modal de frases salvas |

## Como escrever sobre isto

| Não escreva | Escreva |
|---|---|
| "o grant prova que o paciente confirmou" | "o grant prova a procedência do texto" |
| "fala verificada do paciente" | "fala registrada por acompanhante autorizado" |
| "consentimento validado" | "observação registrada por [quem], em [quando]" |

---

## Referências no código

| Onde | O quê |
|---|---|
| [`lib/voice/speech-grant.ts`](../lib/voice/speech-grant.ts) | Emissão e verificação; a seção "o que prova e o que não prova" |
| [`lib/voice/speech-sources.ts`](../lib/voice/speech-sources.ts) | As seis origens legítimas e como cada uma é resolvida |
| [`lib/helo-action-registry.ts`](../lib/helo-action-registry.ts) | `HeloActionClass`, `isActionAllowedFor` |
| [`docs/fase-5.0-voz-auditoria.md`](fase-5.0-voz-auditoria.md) | A auditoria que originou R-01 a R-05 |
