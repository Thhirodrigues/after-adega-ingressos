// Roda no build do Cloudflare, depois do `wrangler deploy`.
// Copia PEPPER, QR_SECRET e SETUP_KEY (variáveis de Build) para segredos do Worker.
import { spawnSync } from 'node:child_process';

const nomes = ['PEPPER', 'QR_SECRET', 'SETUP_KEY'];
// Se o segredo existir como variável de Build, copia para o Worker. Se você o criou direto no
// Worker (Settings → Variables and secrets), ele já está lá: não é erro, só não precisa copiar.
const presentes = nomes.filter((n) => process.env[n]);
if (presentes.length) {
  const json = JSON.stringify(Object.fromEntries(presentes.map((n) => [n, process.env[n]])));
  const r = spawnSync('npx', ['wrangler', 'secret', 'bulk'], { input: json, stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(`Segredos aplicados ao Worker: ${presentes.join(', ')}.`);
} else {
  console.log('Nenhuma variável de Build de segredo; usando os segredos já cadastrados no Worker.');
}

// Cria/atualiza as tabelas no D1 real (só aplica o que ainda não foi aplicado).
const m = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'ingressos', '--remote'], { stdio: 'inherit' });
if (m.status !== 0) {
  console.error('FALHA ao aplicar as migrações no D1 (veja a mensagem acima).');
  process.exit(m.status ?? 1);
}
console.log('Migrações do banco aplicadas.');
