# NeoTalk Avatar 3D

Repositorio independente da plataforma web dos avatares Asuna e LIA. Ele contem o frontend, a API de poses, o container Docker e os binarios Unity WebGL necessarios para executar os avatares. O projeto-fonte do Unity nao faz parte deste repositorio.

## Executar

```powershell
Copy-Item .env.example .env
docker compose up --build -d
```

Abra:

- Player: `http://localhost:8080`
- MVP do chat: `http://localhost:8080/mvp`
- Widget incorporavel: `http://localhost:8080/widget?avatar=lia`
- OpenAPI: `http://localhost:8080/docs`
- Healthcheck: `http://localhost:8080/api/v1/health`

Se a porta 8080 estiver ocupada, altere `AVATAR3D_HTTP_PORT` no `.env`.

## Integrar ao frontend de traducao

```js
const response = await fetch("http://localhost:8080/api/v1/poses/text", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": "sua-chave",
  },
  body: JSON.stringify({
    name: "traducao.pose",
    fps: 30,
    content: poseText,
  }),
});

const pose = await response.json();
avatarIframe.src = pose.player_url;
```

A API aceita `.pose` 2D (`X Y Confidence`) ou 3D (`X Y Z Confidence`). O arquivo e validado e entregue ao player exatamente como foi recebido, sem normalizacao de eixos, escala, proporcoes ou profundidade.

## Chat MVP

A rota `/mvp` envia a frase ao servico NeoTalk pelo backend, acompanha a tarefa Celery e reproduz o `.pose` retornado no avatar selecionado. O usuario pode alternar entre Asuna e LIA; a escolha e preservada no navegador e o sinal ativo e recarregado durante a troca. A chave da integracao nunca e enviada ao navegador.

Configure no `.env` ou no painel do container:

```env
NEOTALK_API_BASE_URL=https://infra-neotalk-api.k3p3ex.easypanel.host
NEOTALK_API_KEY=sua-chave
NEOTALK_API_TIMEOUT_SECONDS=30
NEOTALK_MVP_POSE_FPS=30
```

O botao de microfone usa o reconhecimento de voz disponibilizado pelo navegador e preenche o mesmo campo de mensagem do chat.

## Widget para sites externos

A rota `/widget` exibe somente o avatar e recebe frases do site hospedeiro por `window.postMessage`. O processamento continua no backend desta plataforma; portanto, a chave NeoTalk nunca deve ser colocada no site externo.

Configure `AVATAR3D_WIDGET_ORIGINS` com as origens exatas autorizadas e siga o guia de integracao em [WIDGET_INTEGRATION.md](WIDGET_INTEGRATION.md).

## Estrutura

```text
app/                 FastAPI, validacao pass-through e SQLite
frontend/            interface web e integracao JavaScript
tests/               testes de formato e API
webgl/               catalogo e builds Unity WebGL de Asuna e LIA
Dockerfile           imagem unica para API, frontend e WebGL
compose.yaml         servico e volume persistente
```

## Variaveis principais

| Variavel | Padrao | Uso |
|---|---:|---|
| `AVATAR3D_HTTP_PORT` | `8080` | Porta publicada pelo Docker |
| `AVATAR3D_CORS_ORIGINS` | `*` | Origens permitidas, separadas por virgula |
| `AVATAR3D_WIDGET_ORIGINS` | valor de `AVATAR3D_CORS_ORIGINS` | Sites que podem incorporar e controlar `/widget` |
| `AVATAR3D_API_KEY` | vazio | Protege os endpoints de escrita |
| `AVATAR3D_MAX_POSE_BYTES` | `20971520` | Limite do upload |
| `AVATAR3D_MAX_POSE_FRAMES` | `10000` | Limite de frames |
| `AVATAR3D_KEEP_ORIGINALS` | `true` | Preserva o arquivo recebido |

Veja todas as configuracoes em `.env.example`.

## Desenvolvimento

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest -q
```

Os arquivos `webgl/*/Build/*.data` e `*.wasm` usam Git LFS. Instale o Git LFS antes de clonar ou publicar este repositorio.

Para atualizar os avatares, execute `BuildAvatarWebGL.BuildAllFromCommandLine` no projeto Unity original e substitua o conteudo de `webgl/`. O arquivo `webgl/catalog.json` lista os avatares e cada subpasta (`webgl/asuna` e `webgl/lia`) possui seu proprio `manifest.json` e runtime.

Antes de publicar o repositorio, confirme que a licenca do modelo Asuna permite redistribuir os binarios WebGL gerados.
