# Changelog

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
