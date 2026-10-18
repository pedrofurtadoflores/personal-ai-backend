const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Normaliza o par para o formato exigido por `sinapse_links` (sinapse_a < sinapse_b).
 * Converte para minúsculas antes de comparar: em minúsculas, a ordem do texto é igual à
 * ordem do tipo uuid no Postgres; com letras maiúsculas ela diverge e o CHECK falharia.
 */
export function orderedPair(a: string, b: string): { sinapseA: string; sinapseB: string } {
  const first = a.toLowerCase()
  const second = b.toLowerCase()
  if (!UUID.test(first) || !UUID.test(second)) throw new Error("IDs de sinapse inválidos")
  if (first === second) throw new Error("Uma sinapse não pode se conectar a ela mesma")
  return first < second
    ? { sinapseA: first, sinapseB: second }
    : { sinapseA: second, sinapseB: first }
}
