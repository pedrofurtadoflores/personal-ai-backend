import { isIPv4, isIPv6 } from "node:net"

/**
 * Chave usada no rate limit e no bloqueio de login.
 * IPv4: o próprio endereço. IPv6: o prefixo /64, porque qualquer pessoa com IPv6 controla
 * bilhões de endereços dentro do seu /64 e trocaria de "IP" a cada tentativa.
 */
export function clientKey(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return mapped[1]!
  if (isIPv4(ip)) return ip

  const address = ip.split("%")[0]! // remove zone id (fe80::1%eth0)
  if (!isIPv6(address)) return ip

  return `${expandIPv6(address).slice(0, 4).join(":")}::/64`
}

function expandIPv6(address: string): string[] {
  const [head = "", tail = ""] = address.toLowerCase().split("::")
  const headGroups = head ? head.split(":") : []
  const tailGroups = address.includes("::") && tail ? tail.split(":") : []
  const missing = 8 - headGroups.length - tailGroups.length
  const groups = address.includes("::")
    ? [...headGroups, ...Array<string>(missing).fill("0"), ...tailGroups]
    : headGroups
  return groups.map((group) => group.replace(/^0+(?=.)/, ""))
}
