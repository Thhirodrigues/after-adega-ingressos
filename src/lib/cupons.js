import { HttpError, agora, auditar } from './http.js';

// Palavra-chave do cupom: sem acento, sem espaço, MAIÚSCULAS (quem digita "vip 2026" ou "Vip2026" acerta igual).
export const normalizarCupom = (x) =>
  String(x ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '')
    .toUpperCase();

export const TIPOS_CUPOM = ['sem_taxa', 'percentual', 'vip'];

// Ingressos já usados pelo cupom: pedidos pagos + reservas ainda valendo.
export const SQL_USADOS = `(SELECT COALESCE(SUM(p.quantidade), 0) FROM pedidos p
   WHERE p.cupom_id = cupons.id
     AND (p.status = 'pago' OR (p.status = 'aguardando_pagamento' AND p.reserva_ativa = 1)))`;

// Procura o cupom digitado pelo comprador. Qualquer falha devolve a mesma mensagem
// (não revela se a palavra existe, está desativada ou esgotou). Poucas tentativas erradas por pessoa.
export async function buscarCupomParaCompra(db, usuarioId, eventoId, digitado) {
  const codigo = normalizarCupom(digitado);
  if (!codigo) return null;
  const t = agora();
  const erradas = await db
    .prepare(`SELECT COUNT(*) AS n FROM auditoria WHERE usuario_id = ?1 AND acao = 'cupom_invalido' AND criado_em > ?2`)
    .bind(usuarioId, t - 600)
    .first();
  if (erradas.n >= 5) throw new HttpError(429, 'Muitas tentativas de cupom. Aguarde alguns minutos.');
  const cupom = await db
    .prepare(`SELECT *, ${SQL_USADOS} AS usados FROM cupons WHERE evento_id = ?1 AND codigo = ?2 AND ativo = 1`)
    .bind(eventoId, codigo)
    .first();
  if (!cupom || (cupom.limite != null && cupom.usados >= cupom.limite)) {
    await auditar(db, usuarioId, 'cupom_invalido', codigo.slice(0, 30));
    throw new HttpError(400, 'Cupom inválido ou indisponível.');
  }
  return cupom;
}

// Valores do pedido. subtotal = ingressos pelo preço cheio; desconto sai do subtotal;
// a taxa de serviço incide sobre o que sobra depois do desconto (cupom "sem taxa" e VIP zeram a taxa).
export function calcularValores(valorUnitCentavos, quantidade, taxaPercentual, cupom = null) {
  const subtotal = valorUnitCentavos * quantidade;
  let desconto = 0;
  if (cupom?.tipo === 'vip') desconto = subtotal;
  else if (cupom?.tipo === 'percentual') desconto = Math.floor((subtotal * cupom.percentual + 50) / 100);
  const base = subtotal - desconto;
  const semTaxa = cupom?.tipo === 'sem_taxa' || cupom?.tipo === 'vip';
  const taxa = semTaxa ? 0 : Math.floor((base * taxaPercentual + 50) / 100);
  return { subtotal, desconto, taxa, total: base + taxa };
}
