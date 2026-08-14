# Integracao do widget de avatar NeoTalk

Este guia e para o time que vai exibir somente a caixa da LIA ou da Asuna em um site externo e enviar frases para ela sinalizar.

## Contrato da integracao

- O site externo incorpora `https://SEU-DOMINIO-AVATAR/widget` em um `iframe`.
- O site externo envia a frase ao iframe com `window.postMessage`.
- O widget chama o backend NeoTalk, acompanha a tarefa, recebe o `.pose` normalizado e o reproduz no avatar.
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

## 2. Codigo pronto para o site externo

HTML:

```html
<div class="avatar-box">
  <iframe
    id="neotalk-avatar"
    title="Tradutor em LIBRAS"
    src="https://SEU-DOMINIO-AVATAR/widget?avatar=lia&loop=1&background=%23ffffff"
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

## 3. Parametros da URL

| Parametro | Valores | Padrao | Finalidade |
|---|---|---|---|
| `avatar` | `lia` ou `asuna` | `lia` | Avatar inicial |
| `phrase` | texto, codificado na URL | vazio | Frase executada uma vez apos o carregamento |
| `loop` | `1`/`true` ou `0`/`false` | `1` | Repeticao automatica do sinal |
| `zoom` | `0.76` a `1.48` | por avatar | Enquadramento inicial |
| `background` | cor `#RRGGBB` | `#ffffff` | Fundo do renderizador |
| `controls` | `1` ou `0` | `0` | Exibe ou oculta os botoes de zoom |

Para uma frase inicial, monte a URL com `URLSearchParams`; nao concatene texto manualmente:

```js
const url = new URL("https://SEU-DOMINIO-AVATAR/widget");
url.search = new URLSearchParams({
  avatar: "lia",
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
- `avatar`: somente `lia` ou `asuna`.

## 5. Eventos emitidos pelo widget

| Evento | Campos principais | Quando ocorre |
|---|---|---|
| `neotalk:ready` | `avatar`, `version`, `capabilities` | WebGL pronto para receber comandos |
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
5. Abra `/widget?avatar=lia` diretamente e confirme o carregamento da LIA.
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
