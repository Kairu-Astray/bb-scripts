/**
 * Get information about a specific player.
 * @param {string} name - The name of the player.
 * @returns {Player} Information about the player, or null if the player does not exist.
 */
export function getPlayer(name) {
    let players = ns.ls("home")
      .filter(f => f.endsWith(".txt"))
      .map(f => f.slice(0, -4));
    return players.includes(name) ? {
      name: name,
      money: ns.getServerMoneyAvailable(name),
      hacking: ns.getServerRequiredHackingLevel(name),
      strength: ns.getServerRequiredStrengthLevel(name),
      agility: ns.getServerRequiredAgilityLevel(name),
      charisma: ns.getServerRequiredCharismaLevel(name),
      intelligence: ns.getServerRequiredIntelligenceLevel(name),
      credits: ns.getServerMaxMoney(name),
      hackingExp: ns.getServerHackingExp(name),
      strengthExp: ns.getServerStrengthExp(name),
      agilityExp: ns.getServerAgilityExp(name),
      charismaExp: ns.getServerCharismaExp(name),
      intelligenceExp: ns.getServerIntelligenceExp(name),
      skills: ns.getServerSkills(name),
      level: ns.getServerLevel(name),
      offlineTime: ns.getServerOfflineTime(name),
      lastAccessed: ns.getServerLastAccessed(name),
      connected: ns.serverExists(name),
      ip: ns.getServerIP(name),
      port: ns.getServerPort(name),
      maxRam: ns.getServerMaxRam(name),
      usedRam: ns.getServerUsedRam(name),
      script: ns.getServerScript(name),
      visited: ns.hasVisited(name),
      files: ns.ls("home", name).filter(f => !f.endsWith(".txt"))
    } : null;
  }

