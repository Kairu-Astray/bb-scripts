export async function main(ns) {
  if (ns.getHostname() !== "home") {
    throw new Exception("Run the script from home");
  }

  let args = ns.flags([['branch', 'main']])

  await ns.wget(
    `https://raw.githubusercontent.com/jenheilemann/bitburner-scripts/${args.branch}/src/initStartup.js?ts=${new Date().getTime()}`,
    "initStartup.js"
  );
  ns.spawn("initStartup.js", 1, '--branch', args.branch);
}