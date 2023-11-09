/** @param {NS} ns */
export async function main(ns) {
  let target = "w0r1d_d43m0n"

  ns.brutessh(target)
  ns.ftpcrack(target)
  ns.httpworm(target)
  ns.relaysmtp(target)
  ns.sqlinject(target)
}