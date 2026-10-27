// Evento "aberto" para quem não é admin: marcado como ativo pelo admin e ainda não chegou a data/horário de
// término definidos no evento (a festa vai até de madrugada, então o término costuma ser no dia seguinte).
// Depois disso, comprador e portaria deixam de ver o evento; o admin continua vendo tudo.
// O Brasil não tem horário de verão desde 2019: São Paulo é sempre UTC-3.
export const eventoAberto = (a = 'e') =>
  `(${a}.ativo = 1 AND datetime('now', '-3 hours') < COALESCE(${a}.data_fim, date(${a}.data_evento, '+1 day')) || ' ' || ${a}.hora_fim || ':00')`;
