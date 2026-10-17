import { agora } from './http.js';
import { enviarPush } from './push.js';

// Registra um aviso para o admin e tenta tocar o celular dele (push). Nunca derruba a operação.
export async function alertar(c, tipo, detalhe) {
  const db = c.env.DB;
  await db
    .prepare('INSERT INTO alertas (tipo, detalhe, criado_em) VALUES (?1, ?2, ?3)')
    .bind(tipo, String(detalhe).slice(0, 300), agora())
    .run();
  const origem = new URL(c.req.url).origin;
  const tarefa = enviarPush(db, origem).catch(() => {});
  try {
    c.executionCtx.waitUntil(tarefa);
  } catch {
    await tarefa;
  }
}

const brlTxt = (n) => (n / 100).toFixed(2).replace('.', ',');

// Aviso de novo pedido: só quando a pessoa escolhe a forma de pagamento (não quando apenas clica em comprar).
// Trocar entre cartão e Pix do Mercado Pago não repete o aviso; mudar para o Pix na chave (ou o contrário) avisa de novo,
// porque muda como o dinheiro vai chegar.
export async function avisarPedidoEmPagamento(c, pedido, usuario, forma) {
  const db = c.env.DB;
  const ja = await db
    .prepare(`SELECT 1 FROM alertas WHERE tipo = 'novo_pedido' AND detalhe LIKE ?1 LIMIT 1`)
    .bind(`Novo pedido ${pedido.codigo}:%${forma.includes('Mercado Pago') ? '(Mercado Pago)' : 'Pix na chave'}%`)
    .first();
  if (ja) return;
  await alertar(
    c,
    'novo_pedido',
    `Novo pedido ${pedido.codigo}: **${usuario.nome} ${usuario.sobrenome}** — ${pedido.quantidade} ingresso(s), R$ ${brlTxt(pedido.total_centavos)}${pedido.cupom_codigo ? ` (cupom ${pedido.cupom_codigo})` : ''} (${forma.includes('Mercado Pago') ? 'Mercado Pago' : 'Pix na chave'}). Aguardando pagamento.`,
  );
}
