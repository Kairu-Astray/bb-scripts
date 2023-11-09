/** @param {NS} ns */
export async function main(ns) {
  const [target, id, command, params] = ns.args

  let b3 = eval('window.b3')
  if (!b3) return;
  
  // exit script if it's not present, i.e. in reset, so we can restart batches

  var handle = ns.getPortHandle(1)
  let start = new Date().valueOf()
  let instance = Array(8)
  instance[0] = 'weak'
  instance[1] = id
  instance[2] = command
  instance[3] = params
  instance[4] = start
  b3.started.push(instance)
  let result = await ns.hack(target)
  let end = new Date().valueOf()
  instance[5] = end
  instance[6] = end - start
  instance[7] = result
  b3.completed.push(instance)
  handle.write(JSON.stringify({ id, command, params }))
}
