// Evento "aberto" para quem não é admin: marcado como ativo pelo admin e ainda não passou do meio-dia (SP)
// do dia seguinte à festa (ela termina de madrugada, a portaria precisa funcionar até o fim).
// Depois disso, comprador e portaria deixam de ver o evento; o admin continua vendo tudo.
// O Brasil não tem horário de verão desde 2019: São Paulo é sempre UTC-3.
export const eventoAberto = (a = 'e') =>
  `(${a}.ativo = 1 AND datetime('now', '-3 hours') < datetime(${a}.data_evento, '+1 day', '+12 hours'))`;
