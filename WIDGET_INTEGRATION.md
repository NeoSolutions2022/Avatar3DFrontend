# Integracao do widget de avatar NeoTalk

Este guia e para o time que vai exibir somente a caixa da LIA, ELIA ou Asuna em um site externo e enviar frases para ela sinalizar.

## Contrato da integracao

- O site externo incorpora `https://SEU-DOMINIO-AVATAR/widget` em um `iframe`.
- O site externo envia a frase ao iframe com `window.postMessage`.
- O widget chama o backend NeoTalk, acompanha a tarefa, recebe o `.pose` original sem transformacoes intermediarias e o reproduz no avatar.
- Ao receber o `task_id`, o widget consulta o status imediatamente. Enquanto a tarefa processa, usa os intervalos progressivos `0 ms`, `300 ms`, `500 ms`, `800 ms` e `1.200 ms`; depois permanece em `1.200 ms`.
- A chave `NEOTALK_API_KEY` permanece exclusivamente no servidor do Avatar3DPlatform.
- O site externo nao deve chamar a API NeoTalk diretamente e nao precisa conhecer nenhuma chave privada.

## 1. Configuracao obrigatoria no servidor

No EasyPanel/Docker, defina as origens que poderao incorporar e controlar o widget:

```env
AVATAR3D_WIDGET_ORIGINS=https://app.seudominio.com,https://www.seudominio.com
```

Use apenas a origem (`protocolo + dominio + porta`, quando houver), sem caminho e sem barra final. Exemplos validos:

```text
https://app.seudominio.com
http://localhost:3000
https://homologacao.seudominio.com:8443
```

Reinicie/reimplante o container depois de alterar a variavel. Em producao, nao use `*`.

Para previews executados dentro de iframes com `sandbox` (por exemplo, o editor
do Lovable), use temporariamente `AVATAR3D_WIDGET_ORIGINS=*`. Nesse modo a
plataforma nao envia `frame-ancestors`, pois a origem opaca do preview nao e
compativel com uma allowlist CSP. Restrinja novamente a origens exatas antes de
publicar em producao.

## 2. Codigo pronto para o site externo

### Velocidade de execucao da ELIA no modo apresentacao

No EasyPanel/Docker, uma variavel opcional permite acelerar sem recompilar Unity:

```env
AVATAR3D_ELIA_PLAYBACK_SPEED=1.5
```

Reinicie/reimplante o servico depois da mudanca e recarregue o iframe. A
configuracao e lida no servidor e entregue por `/api/v1/widget/config` sem cache;
nao e uma variavelVite embutida no JavaScript. O widget reaplica na inicializacao
da ELIA e nas trocas de avatar. Nao altera LIA/Asuna, fonte `.pose`, FPS nominal,
amortecimento, liberdade, IDs de reproducao ou preparacaoPPC.

- Vazio/ausente: preserva a velocidade salva no Unity, atualmente1.2.
-1.5:50%acima de1x;25%mais rapido que1.2. Tempo de execucao cai20%vs1.2.
- Faixa aceita pelo runtime atual0.5..1.5; valores finitos fora disso sao
  limitados. `2`resulta1.5, nao2x. Invalidos/NaN/Infinity sao ignorados.
- Precisa desta atualizacao do backend/widget/manifesto. Os binariosELIA.34
  ja contem `SetEliaLecturePlaybackSpeed(float)`; nenhum WebGLnovo foi gerado.
- Builds/manifestos sem a capacidade declarada nao recebem o comando: widget
  emite status`playback_speed_unsupported`, sem quebrar a animacao.
- Funciona somente se o ModoPalestra/Evento estiver ativo na ELIA. Nao acelerar
  preparacao/loading nem prometer igual qualidade visual na taxa maior.

Para voltar, remova a variavel e reinicie/recarregue o widget, ou use1.2. A
configuracao e publica e nao deve conter credenciais. Nenhum deploy/push e feito
automaticamente ao editar esses arquivos locais.

### Liberdade visual da ELIA no Evento Ultra

Controle independente da velocidade, para relaxar moderadamente os trilhos dos
bracos/maos, o orcamento do punho e a articulacao dos dedos:

```env
AVATAR3D_ELIA_PLAYBACK_SPEED=1.5
AVATAR3D_ELIA_PRESENTATION_FREEDOM=0.5
```

- Faixa0..1. Comece com0.5: e o candidato intermediario avaliado;1 e o maximo
  experimental, nao "100%livre" nem garantia de anatomia/contatos sem anomalias.
-0 restaura o envelope anterior; vazio/ausente mantem o valor salvo no Unity
  (atualmente0). Invalidos/NaN/Infinity sao ignorados e finitos fora da faixa
  sao limitados. Use ponto decimal, nao virgula.
- Atua em bracos, punhos, maos e dedos JUNTOS; nao e controle exclusivo dos dedos.
  Requer Evento Ultra ativo. Nao muda velocidade, PPC, IDs nem os `.pose`.
- **Diferente da velocidade, requer uma nova buildWebGL UMA vez** com
  `SetEliaLectureFreedom(float)`. A.34atualNAOpossui esse comando. O gerador de
  manifestosUnity foi atualizado para declarar `presentationFreedom:{min:0,max:1}`
  somente nas NOVAS buildsELIA. Publique build e manifesto correspondentes juntos;
  nunca acrescente a capacidade manualmente ao manifesto da.34antiga.
- Sem capacidade compativel, o widget emite `presentation_freedom_unsupported`,
  nao envia o metodo inexistente e segue reproduzindo normalmente.
- Apos atualizar backend/widget e publicar a build compativel, mude a variavel,
  reinicie/reimplante o servico e recarregue o iframe. Proximos ajustes de valor
  nao exigem recompilar Unity. E variavel do SERVIDOR, nao Vite nem do site pai.
- Configuracao por `/api/v1/widget/config`semcache; enviada numericamente ao
  Unity uma vez na inicializacao, antes do preview/primeiro sinal, e reaplicada
  nas trocas de avatar. Nao e rampa de ajuste ao vivo no meio do sinal.
- `neotalk:ready`pode anunciar a capacidade`presentation-freedom`; seu campo
  `presentationFreedom`indica o ultimo valor ENVIADO (ou null), nao ACK nativo
  de efeito visual. Nao altera o contrato de confirmacao de reproducao.

Implementado/testado localmente; nenhuma nova build/publicacao ou validacao no
navegador foi feita automaticamente por esse ajuste de configuracao.

HTML:

```html
<div class="avatar-box">
  <iframe
    id="neotalk-avatar"
    title="Tradutor em LIBRAS"
    src="https://SEU-DOMINIO-AVATAR/widget?avatar=elia&loop=1&background=%23ffffff"
    allow="fullscreen"
  ></iframe>
</div>
```

CSS:

```css
.avatar-box {
  width: min(100%, 420px);
  aspect-ratio: 3 / 4;
  overflow: hidden;
  border-radius: 20px;
  background: #fff;
}

.avatar-box iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
```

JavaScript:

```js
const AVATAR_ORIGIN = "https://SEU-DOMINIO-AVATAR";
const avatarFrame = document.querySelector("#neotalk-avatar");
let avatarReady = false;

window.addEventListener("message", (event) => {
  // Obrigatorio: nunca aceite eventos de qualquer origem.
  if (event.origin !== AVATAR_ORIGIN || event.source !== avatarFrame.contentWindow) return;

  const message = event.data;
  if (!message || typeof message !== "object") return;

  if (message.type === "neotalk:ready") {
    avatarReady = true;
    console.log("Avatar pronto:", message.avatar);
    console.log("Avatares disponiveis:", message.avatars);
  }

  if (message.type === "neotalk:status") {
    console.log("Estado do avatar:", message.status);
  }

  if (message.type === "neotalk:playing") {
    console.log("Sinal em reproducao:", message.phrase, message.words);
  }

  if (message.type === "neotalk:error") {
    console.error("Erro no avatar:", message.code, message.message);
  }
});

function sinalizar(frase) {
  if (!avatarReady) throw new Error("O avatar ainda nao esta pronto.");
  avatarFrame.contentWindow.postMessage(
    { type: "neotalk:sign", phrase: frase },
    AVATAR_ORIGIN,
  );
}

// Exemplo: sinalizar("ola tudo bem");
```

Registre o listener de `message` antes de permitir que o usuario envie uma frase. Envie comandos somente depois de receber `neotalk:ready`.

Depois da primeira execução, o widget mantém as últimas 24 poses na memória da aba. Para repetir uma frase sem criar outra tarefa na API de poses, envie:

```js
avatarFrame.contentWindow.postMessage(
  { type: "neotalk:replay", phrase: fraseEmGlosas },
  "https://SEU-DOMINIO-AVATAR",
);
```

O cache é deliberadamente temporário: ele desaparece ao recarregar o widget e nunca mistura sessões de usuários diferentes.

Quando há duas saídas da mesma sala, o widget que recebe `neotalk:sign` emite `neotalk:pose-ready` com `phrase`, `pose` e `words` assim que a tarefa termina. O controlador pode encaminhar esses dados ao segundo widget com `{ type: "neotalk:load-pose", phrase, pose, words }`. O segundo widget reproduz a pose sem criar outra tarefa. A capacidade `shared-pose` em `neotalk:ready` indica suporte a esse comando; o controlador deve aguardar `ready` de cada saída. A URL em `pose.content_url` precisa pertencer ao próprio servidor do widget.

O widget emite `neotalk:pose-stage` para `pose_available`, `load_sent`, `unity_ack`, `unity_ack_timeout`, `unity_load_error`, `play_requested` e `cancelled`. Cada evento inclui `loadId`, `correlationId`, `poseId`, tentativa e tempos disponíveis; `traceId` liga a resposta da API aos logs do backend. O carregamento tenta novamente a mesma URL uma vez antes de reportar `pose_ack_timeout`/`pose_load_failed`, sem criar uma nova tarefa nem exibir alerta vermelho no widget. `play_requested` registra o comando enviado ao Unity, não comprova visualmente a animação. O callback atual do Unity informa apenas sucesso/erro, sem identidade da pose (`acknowledgedPoseId: false`); para confirmação inequívoca, o build Unity precisará devolver o `loadId` no evento `avatar3d-pose-load`.

## 3. Parametros da URL

| Parametro | Valores | Padrao | Finalidade |
|---|---|---|---|
| `avatar` | `lia`, `elia` ou `asuna` | `lia` | Avatar inicial |
| `phrase` | texto, codificado na URL | vazio | Frase executada uma vez apos o carregamento |
| `loop` | `1`/`true` ou `0`/`false` | `1` | Repeticao automatica do sinal |
| `zoom` | `0.76` a `1.48` | por avatar | Enquadramento inicial |
| `background` | cor `#RRGGBB` | `#ffffff` | Fundo do renderizador |
| `controls` | `1` ou `0` | `0` | Exibe ou oculta os botoes de zoom |

Para uma frase inicial, monte a URL com `URLSearchParams`; nao concatene texto manualmente:

```js
const url = new URL("https://SEU-DOMINIO-AVATAR/widget");
url.search = new URLSearchParams({
  avatar: "elia",
  phrase: "bom dia",
  loop: "1",
  background: "#ffffff",
});
avatarFrame.src = url.toString();
```

O parametro `phrase` e indicado apenas para a primeira frase. Para todas as frases seguintes, use `postMessage`, pois isso evita recarregar o WebGL.

## 4. Comandos aceitos

Todos os comandos sao enviados para `avatarFrame.contentWindow` com o dominio exato do widget como `targetOrigin`.

```js
// Traduzir e reproduzir uma frase.
{ type: "neotalk:sign", phrase: "libras comunicacao melhor" }

// Trocar o avatar e manter a pose atual.
{ type: "neotalk:set-avatar", avatar: "asuna" }
{ type: "neotalk:set-avatar", avatar: "lia" }
{ type: "neotalk:set-avatar", avatar: "elia" }

// Ajustes visuais.
{ type: "neotalk:set-zoom", zoom: 1.2 }
{ type: "neotalk:set-background", background: "#ffffff" }
{ type: "neotalk:set-loop", loop: true }

// Controle da reproducao atual.
{ type: "neotalk:play" }
{ type: "neotalk:pause" }
{ type: "neotalk:restart" }
```

Limites:

- `phrase`: de 1 a 500 caracteres.
- `zoom`: de `0.76` a `1.48`.
- `background`: formato hexadecimal completo `#RRGGBB`.
- `avatar`: somente `lia`, `elia` ou `asuna`.

## 5. Eventos emitidos pelo widget

| Evento | Campos principais | Quando ocorre |
|---|---|---|
| `neotalk:ready` | `avatar`, `avatars`, `version`, `capabilities` | WebGL pronto para receber comandos; `avatars` inclui `asuna`, `lia` e `elia` |
| `neotalk:status` | `status`, `avatar` e contexto | Mudanca de estado |
| `neotalk:playing` | `phrase`, `words`, `taskId`, `avatar` | Pose carregada e em reproducao |
| `neotalk:error` | `code`, `message`, `avatar` | Falha de inicializacao, comando ou processamento |

Valores atuais de `status`:

```text
loading_avatar -> ready -> queued -> processing -> loading_pose -> playing
```

## 6. Checklist de publicacao

1. Configure `NEOTALK_API_KEY` somente no container do Avatar3DPlatform.
2. Configure `AVATAR3D_WIDGET_ORIGINS` com todos os dominios autorizados.
3. Reimplante o container.
4. Confirme que `GET /api/v1/health` retorna `webgl_ready: true` e `mvp_ready: true`.
5. Abra `/widget?avatar=elia` diretamente e confirme o carregamento da ELIA.
6. Teste a incorporacao a partir de uma origem autorizada.
7. Confirme os eventos `neotalk:ready`, `neotalk:status` e `neotalk:playing` no site externo.
8. Confirme que nenhuma chave privada aparece no HTML, JavaScript ou painel Network do site externo.

## 7. Diagnostico rapido

### O iframe foi bloqueado

A origem do site externo nao esta em `AVATAR3D_WIDGET_ORIGINS`, ou o container ainda usa a configuracao anterior. Corrija a variavel e reimplante.

### O widget aparece, mas ignora comandos

Verifique simultaneamente:

- o site externo usa o dominio exato do widget como `targetOrigin`;
- o listener valida o mesmo dominio em `event.origin`;
- a origem do site externo esta em `AVATAR3D_WIDGET_ORIGINS`;
- o comando foi enviado depois de `neotalk:ready`.

### O avatar carrega, mas a frase falha

Consulte `/api/v1/health`. `mvp_ready` precisa ser `true`. Depois confira `NEOTALK_API_BASE_URL`, `NEOTALK_API_KEY` e os logs do container.

### Desenvolvimento local

Inclua a origem local explicitamente:

```env
AVATAR3D_WIDGET_ORIGINS=http://localhost:3000
```

Se o site local roda em outra porta, essa porta faz parte da origem e tambem precisa ser configurada.
