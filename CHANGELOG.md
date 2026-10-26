# Changelog

## 2026-10-26 — Pool HTTPS do proxy (candidata)

- Cliente HTTP limitado e gerenciado pelo lifespan também no proxy do avatar;
  autenticação por chamada, sem cookies persistidos nem chave nos downloads.
- Limites de resposta/arquivo, encerramento, redirects e erros por etapa cobertos.
- HTTPS real ao mesmo resultado concluído: seis rodadas por variante/três
  consultas, média por rodada 1.502,17→824,90 ms, sem latência artificial.
  Ganho restrito ao transporte, não 45% de ganho da Elia ou da sala.
- 32 Python + 28 Node passaram; dez lotes/70 palavras completos com dois Unity
  reais/PiP nativo, ASR controlado, sem reset/pausa/rejeição. Fluidez ainda pendente.
- Sem novo WebGL, mudança de sinais/mãos/cenas, merge ou deploy de produção.
- [Dados, gráfico e limites](docs/performance/2026-10-26/README.md).

## 2026-10-26 — Widget 2026.10.26-elia.30 (candidata)

- Prefetch compartilha a consulta e o download do arquivo até a prontidão real
  dos bytes; um `sign` concorrente não inicia outra transferência para Unity.
- No máximo dois trabalhos antecipados por geração do widget; excesso de
  warmup é não bloqueante e a reprodução sob demanda continua disponível.
- Geração invalidada deixa de ser elegível para cache/publicação após troca
  de avatar. Erro de download mantém o caminho normal de carregamento.
- 28 testes Node passaram, incluindo sete novos de corrida, burst, 502,
  cancelamento e HTTP loopback real. Nenhum WebGL/pose/mãos alterado.
- Ensaio local com cinco lotes e dois Unity reais passou; não demonstra ganho
  ponta a ponta. Metodologia e limites: docs/WIDGET-PREFETCH-RACE-2026-10-26.md.

## 2026-10-08 — Widget 2026.10.08-elia.29

- Nova capacidade `presentation-playlist`: prepara uma sequência longa a partir
  de 2 a 64 poses, com até dois downloads simultâneos.
- Composição em memória preserva registros de corpo/mãos e renumera frames.
- Prontidão depende do primeiro frame nativo real, não apenas do ACK/download.
- Pausa/continuação usa o frame atual, sem nova carga ou `PlayFromStart`.
- Cancelamento, validação de origem e limites de 64 MB/12.000 frames.
- Progresso da apresentação separado do contrato de lotes de tradução real.
- Mesmo WebGL .28: sem alterações Unity, cenas, poses, mãos ou outros avatares.
- Uso ilustrativo: a plataforma deve manter aviso visível e controle admin;
  não representar os gestos como tradução das legendas.

### Verificação

- 15 testes Node e 16 testes Python aprovados.
- Integração local na plataforma com dois Unity reais, pausa/retomada/silêncio,
  sem reinicialização nem cargas adicionais durante a fala.
- Preparação inicial pode ser demorada. Não certifica todos os dispositivos
  nem aprovação visual/linguística do catálogo completo.
- Detalhes: [contrato e limites](docs/WIDGET-PRESENTATION-2026-10-08.md).
