// Roda no build do Cloudflare, depois do `wrangler deploy`.
// Copia PEPPER, QR_SECRET e SETUP_KEY (variáveis de Build) para segredos do Worker.
import { spawnSync } from 'node:child_process';

const nomes = ['PEPPER', 'QR_SECRET', 'SETUP_KEY'];
const faltando = nomes.filter((n) => !process.env[n]);
if (faltando.length) {
  console.error(`Faltam variáveis de Build: ${faltando.join(', ')}`);
  process.exit(1);
}
const json = JSON.stringify(Object.fromEntries(nomes.map((n) => [n, process.env[n]])));
const r = spawnSync('npx', ['wrangler', 'secret', 'bulk'], { input: json, stdio: ['pipe', 'inherit', 'inherit'] });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log('Segredos aplicados ao Worker.');
