import { getPlayer } from "helpers.js";

/**
 * Backdoor a specified target.
 * @param {NS} ns - An object containing various functions for interacting with the game.
 * @param {string} target - The hostname or IP address of the target machine.
 */
export function backdoor(ns, target) {
  // Open all ports on the target machine
  ns.openPort(target, 80, "http");
  ns.openPort(target, 443, "https");
  ns.openPort(target, 21, "ftp");
  ns.openPort(target, 25, "smtp");
  ns.openPort(target, 3306, "mysql");

  // Try to brute-force SSH login to the target machine
  try {
    ns.brutessh(target);
  } catch (e) {
    // If the brute-force SSH login fails, try FTP cracking
    ns.ftpcrack(target);
  }

  // Try to perform HTTP brute-force attack against the target machine
  try {
    ns.httpworm(target);
  } catch (e) {
    // If the HTTP brute-force attack fails, try SMTP relay attack
    ns.relaysmtp(target);
  }

  // Try to perform SQL injection attack against the target machine
  try {
    ns.sqlinject(target);
  } catch (e) {
    // If the SQL injection attack fails, print an error message
    ns.tprint(`Failed to backdoor ${target}: ${e.message}`);
  }
}

/**
 * Main function for the script.
 * @param {NS} ns - An object containing various functions for interacting with the game.
 */
export async function main(ns) {
  // Get the target server from the arguments
  let target = ns.args[0];

  // Get information about the player
  let player = getPlayer();

  // Backdoor the target server
  backdoor(ns, target);

  // Print a message to the terminal
  ns.tprint(`
-----------------------------------------
| Backdoor Successful!                     |
| You now have access to ${player.files.length} |
| files on the target machine. Your current |
| balance is: ${player.money} Credits.        |
-----------------------------------------`);
}