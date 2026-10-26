// Static chart of the recorded real endpoint experiment, never mock/UI data.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require(process.env.QA_SHARP_MODULE || 'C:/Users/felip/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const source = resolve(process.argv[2] || 'docs/performance/2026-10-26/https-status.json');
const data = JSON.parse(await readFile(source, 'utf8'));
if (!data.equivalentResponses || data.roundsPerVariant !== 6 || data.callsPerRound !== 3 || data.samples.length !== 12) throw new Error('Unexpected benchmark population');
const groups = ['urllib', 'pool'].map(variant => data.samples.filter(row => row.variant === variant).sort((a, b) => a.round - b.round));
if (groups.some(rows => rows.length !== 6 || rows.some((row, i) => row.round !== i + 1 || !Number.isFinite(row.totalMs) || row.totalMs < 0 || row.requestMs.length !== 3 || row.requestMs.some(ms => !Number.isFinite(ms) || ms < 0)))) throw new Error('Invalid samples');
const average = rows => rows.reduce((sum, row) => sum + row.totalMs, 0) / rows.length;
const means = groups.map(average);
if (means.some(value => value <= 0)) throw new Error('Invalid round duration');
const reduction = (1 - means[1] / means[0]) * 100;
const requestP95 = groups.map(rows => {
  const values = rows.flatMap(row => row.requestMs).sort((a, b) => a - b);
  return values[Math.ceil(values.length * .95) - 1];
});
const colors = ['#61748c', '#078261'];
const maximum = Math.max(600, Math.ceil(Math.max(...groups.flatMap(rows => rows.map(row => row.totalMs))) / 600) * 600);
const y = ms => 560 - ms / maximum * 300;
const text = (x, y, value, size = 23, fill = '#21324a', extra = '') => `<text x="${x}" y="${y}" font-family="Arial,sans-serif" font-size="${size}" fill="${fill}" ${extra}>${value}</text>`;
const number = value => value.toFixed(1).replace('.', ',');
let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="980" viewBox="0 0 1600 980" role="img"><title>Tempo de consultas HTTPS ao mesmo resultado concluído</title><rect width="1600" height="980" fill="#ffffff"/>';
svg += text(80, 65, 'NeoTalk · PERF-03 · 26/10/2026', 22, '#007da8');
svg += text(80, 112, 'Reuso de conexão no proxy de poses', 40, '#10233f');
svg += text(80, 153, 'HTTPS real · mesmo resultado concluído · 6 rodadas alternadas × 3 consultas por variante', 23, '#52657f');
svg += `<rect x="80" y="195" width="26" height="14" rx="3" fill="${colors[0]}"/>` + text(120, 212, 'urllib · conexão por chamada', 22);
svg += `<rect x="700" y="195" width="26" height="14" rx="3" fill="${colors[1]}"/>` + text(740, 212, 'pool · transporte reutilizado', 22);
for (let i = 0; i <= 3; i++) {
  const ms = i * maximum / 3;
  svg += `<line x1="120" y1="${y(ms)}" x2="1490" y2="${y(ms)}" stroke="#dbe3ed"/>` + text(103, y(ms) + 7, Math.round(ms), 20, '#52657f', 'text-anchor="end"');
}
svg += text(80, 248, 'ms por rodada', 19, '#52657f');
for (let round = 0; round < 6; round++) {
  const center = 230 + round * 225;
  groups.forEach((rows, variant) => {
    const x = center - 75 + variant * 76, value = rows[round].totalMs;
    svg += `<rect x="${x}" y="${y(value)}" width="62" height="${560 - y(value)}" rx="4" fill="${colors[variant]}"/>`;
    svg += text(x + 31, y(value) - 12, Math.round(value), 20, colors[variant], 'text-anchor="middle"');
  });
  svg += text(center, 604, `Rodada ${round + 1}`, 22, '#52657f', 'text-anchor="middle"');
}
svg += text(90, 680, 'Média por rodada (inclui abrir/fechar cliente)', 24);
svg += text(90, 728, `${number(means[0])} ms → ${number(means[1])} ms`, 38, '#10233f');
svg += text(1000, 690, `${number(reduction)}% menos tempo`, 32, '#078261');
svg += text(1000, 729, 'somente neste componente/ensaio', 22, '#52657f');
svg += '<line x1="80" y1="780" x2="1520" y2="780" stroke="#dbe3ed"/>';
svg += text(80, 820, 'Respostas equivalentes em todas as 36 consultas. Sem latência artificial.', 23);
svg += text(80, 862, `A primeira conexão continua fria. p95 por chamada: ${number(requestP95[0])} → ${number(requestP95[1])} ms (18 amostras por variante).`, 22, '#52657f');
svg += text(80, 904, 'Não mede geração de poses, GPT, áudio ou Unity. Não demonstra ganho ponta a ponta na sala.', 22, '#52657f');
svg += text(80, 945, 'Uma tarefa sintética já concluída; condições do endpoint e da rede limitam a generalização.', 21, '#52657f');
svg += '</svg>';
const output = dirname(source);
await writeFile(join(output, 'https-status.svg'), svg);
await sharp(Buffer.from(svg)).png().toFile(join(output, 'https-status.png'));
console.log(output);
