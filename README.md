# NeoTalk Avatar 3D

Repositorio independente da plataforma web da Asuna. Ele contem o frontend, a API de poses, o container Docker e os binarios Unity WebGL necessarios para executar o avatar. O projeto-fonte do Unity nao faz parte deste repositorio.

## Executar

```powershell
Copy-Item .env.example .env
docker compose up --build -d
```

Abra:

- Player: `http://localhost:8080`
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

A API aceita `.pose` 2D (`X Y Confidence`) ou 3D (`X Y Z Confidence`). O movimento e validado, normalizado e persistido antes de ser entregue ao player.

## Estrutura

```text
app/                 FastAPI, normalizacao e SQLite
frontend/            interface web e integracao JavaScript
tests/               testes de formato e API
webgl/               build Unity WebGL da Asuna
Dockerfile           imagem unica para API, frontend e WebGL
compose.yaml         servico e volume persistente
```

## Variaveis principais

| Variavel | Padrao | Uso |
|---|---:|---|
| `AVATAR3D_HTTP_PORT` | `8080` | Porta publicada pelo Docker |
| `AVATAR3D_CORS_ORIGINS` | `*` | Origens permitidas, separadas por virgula |
| `AVATAR3D_API_KEY` | vazio | Protege os endpoints de escrita |
| `AVATAR3D_MAX_POSE_BYTES` | `20971520` | Limite do upload |
| `AVATAR3D_MAX_POSE_FRAMES` | `10000` | Limite de frames |
| `AVATAR3D_KEEP_ORIGINALS` | `true` | Preserva o arquivo recebido |
| `AVATAR3D_NORMALIZATION_MARGIN` | `1.02` | Margem dos comprimentos dos ossos |

Veja todas as configuracoes em `.env.example`.

## Desenvolvimento

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest -q
```

Os arquivos `webgl/Build/*.data` e `*.wasm` usam Git LFS. Instale o Git LFS antes de clonar ou publicar este repositorio.

Para atualizar a Asuna, gere um novo build no projeto Unity original e substitua o conteudo de `webgl/`. O arquivo `webgl/manifest.json` deve apontar para os quatro artefatos presentes em `webgl/Build/`.

Antes de publicar o repositorio, confirme que a licenca do modelo Asuna permite redistribuir os binarios WebGL gerados.
