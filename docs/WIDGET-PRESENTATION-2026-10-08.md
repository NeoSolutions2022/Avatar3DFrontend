# Widget .29 — apresentação ilustrativa experimental

Mesmo WebGL .28: esta alteração não modifica o build Unity, poses originais,
perfis de mãos, retargeting, cenas ou arquivos de outros avatares.

Capacidade nova: `presentation-playlist`. O controlador autorizado envia
`neotalk:prepare-presentation` com `playlistId` e de 2 a 64 objetos `pose`.
URLs continuam restritas ao servidor do widget. O widget baixa com no máximo
duas solicitações simultâneas, renumera somente os IDs de frames e monta uma
sequência longa em memória. Todos os registros de mãos/corpo são preservados.

Limites: 64 MB de conteúdo e 12.000 frames; preparação total limitada a dez
minutos. ACK de carga aguarda até cinco minutos nesta operação, sem tentativa
automática de recarregar o Unity. Esses limites não alteram o fluxo normal.

`neotalk:presentation-ready` é emitido somente após o primeiro frame nativo
real, momento em que a animação é pausada. O controlador só continua quando
há fala captada. `neotalk:play` / `neotalk:pause` continuam/pausam o frame atual:
sem pesquisa, `LoadPoseUrl`, `PlayFromStart` ou preparação entre frases faladas.

`neotalk:presentation-frame` reporta progresso verdadeiro. Não fabrica conclusão
de lotes. `neotalk:stop-presentation` desliga o loop e libera o blob quando seguro.
Cancelar a operação aborta downloads pendentes e invalida a geração anterior.

Não é tradução. A plataforma deve exibir “Demonstração · sinais ilustrativos”
em todas as saídas, restringir o controle ao admin e não criar histórico de
traduções/QA a partir desses gestos. Cache de apresentação é por instância do
widget, na memória do navegador; não é um cache Redis nem recurso offline.

Teste de contrato: `tests/widget-presentation.test.cjs`. Integração real na
plataforma: `tests/presentation-browser.cjs`, com API/ASR controlados e WebGL .28.
Uma confirmação de contrato isolada não certifica todas as poses do catálogo
ou desempenho uniforme em celulares. A preparação inicial pode demorar.

QA local de 08/10/2026: 15 testes Node do widget e 16 testes Python aprovados.
A integração `presentation-1791475362023` executou dois Unity reais, com 12
sequências/1.998 frames, e verificou pausa, retomada, silêncio, carga única por
saída e ausência de reinicialização. A API/transcrição/PiP foram controlados;
não representa certificação de produção nem aprovação visual de 64 sequências.
