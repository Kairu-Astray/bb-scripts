const WEAK_DELAY = 75
const PORT = 5
const RAM_SAFETY_FACTOR = 4 // save room for 4 extra hacks when scheduling grows
const target = 'rho-construction'
const host = 'home'

/*
 
My basic idea with this one is to 

1. Ramp up weakens every 50ms or so until first batch starts hitting
2. ID each script using the current time just before calling 'exec'
3. Have scripts communicate perfectly accurate finish time using ports
4. Keep track of how many grows and hacks are in-process and allow based on that
  * grow() takes 4x the time of hack()
  * don't schedule grows unless the memory available minus missing hacks() meet criteria
5. Maintain separate lists of grow, hack, and weaken that are executing
6. Prefer schedule like weakenx2/grow1/weakenx2/grow2, and fit hacks in between those weakens
  * this means that when we schedule grow, we leave at least two weakens behind it
      since the previous grow, there should be no hacks
  * when scheduling hacks, it can either be within 100ms of the FIRST weaken finishing,
      or between two weakens with a straight path back to a grow

*/

/**
 * @typedef Worker
 * @type {object}
 * @property {number} id - ID - Time when exec() was called - set by worker script from argument
 * @property {string} command - one of 'weak', 'grow', 'hack' - set by worker script
 * @property {number} start - Actual time when last command was started - set by worker script
 * @property {number} time - Estimaged duration - set by worker script
 * @property {number} eEnd - Estimated end time of finish - set by worker script
 * @property {number} end - Actual time when command ends - set by worker script
 * @property {number} result - Actual result of call - set by worker script
 * @property {number} execStart - Expected start time at the point exec() is called
 * @property {number} execEnd - Expected end time at the point exec() is called
 * @property {number} execTime - Expected duration at the point exec() is called
 */

/**
 * @typedef Counts
 * @type {object}
 * @property {number} weak - how many weak are currently executing
 * @property {number} grow - how many grow are currently executing
 * @property {number} hack - how many hack are currently executing
 */



/** @param {NS} ns */
export async function main(ns) {
  // "cheat" with a window object for the purpose of logging and investigation
  const obj = eval("window.obj = {}")
  obj.finished = []
  obj.started = []
  obj.processing = []
  obj.errors = []
  obj.stats = {}
  obj.messages = []
  obj.show = () => {
    console.log('Processing:')
    obj.processing.slice(0, 40).forEach(o => console.log(o?.eEnd, o?.command))
    console.log('Finished:')
    obj.finished.slice(0, 40).forEach(o => console.log(o?.eEnd, o?.command))
  }
  obj.getCounts = () => {
    console.log(JSON.stringify(obj.processing.reduce((p, c) => { p[c.command]++; return p; }, {weak:0,grow:0,hack:0})))

  }

  // port used for scripts reporting start and end information
  const handle = ns.getPortHandle(PORT)
  handle.clear()
  const handle2 = ns.getPortHandle(PORT + 1)
  handle2.clear()

  // disable logs
  var logsToDisable = ['sleep', 'exec', 'getServerUsedRam', 'getServerMaxRam', 'scp']
  logsToDisable.forEach(name => ns.disableLog(name))

  /**
   * Object containing all active workers.  Added to prior to exec()
   * @type {Object<string,Worker}
   */
  let workers = {}
  obj.workers = workers

  /**
   * Array of workers, populated after message was received from script and sorted
   * by eEnd - expected end time set by script with accurate start time and
   * time the command should take to run.  This is used for scheduling and binary
   * searches are used to find things quickly.
   *
   * @type {Worker[]}
   */
   let processing = []
   obj.processing = processing

  /**
   * Function to compare workers using eEnd and then id
   * 
   * @param {Worker} worker1
   * @param {Worker} worker2
   */
   const compareWorkers = (worker1, worker2) => {
    if (!worker2) return -1 // this is 'less' than no worker, for bsearch insert
    if (worker1.eEnd > worker2.eEnd) return 1
    if (worker1.eEnd < worker2.eEnd) return -1
    if (worker1.id > worker2.id) return 1
    if (worker1.id < worker2.id) return -1
    return 0
  }
  obj.compareWorkers = compareWorkers

  /**
   * Use binary search to quickly find worker or location to insert a new worker
   * using 'worker.eEnd' and given two at the same time, use  
   * 
   * @param {Worker} worker
   */
  const findProcessing = (worker) => {
    let min = 0, max = processing.length - 1
    while (min <= max) {
      let index = Math.trunc((min + max) / 2)
      let test = compareWorkers(worker, processing[index])
      if (test > 0) {
        min = index + 1
      } else {
        max = index - 1
      }
    }
    return min;
  }
  obj.findProcessing = findProcessing

  const growScriptRam = ns.getScriptRam('/remote/grow.js')
  const hackScriptRam = ns.getScriptRam('/remote/hack.js')
  const weakScriptRam = ns.getScriptRam('/remote/weak.js')

  /**
   * How many scripts are currently executing, for calculating ram usage
   * @type {Counts}
   */
   const counts = {
    weak: 0,
    grow: 0,
    hack: 0
  }
  obj.counts = counts

  // ensure host has the most recent scripts
  const copyFilesToServer = async (hostname) => {
    ns.print(`Copying files to host ${hostname}`)
    await ns.scp(['/remote/weak.js', '/remote/grow.js', '/remote/hack.js'], hostname)
  }
  if (host !== 'home') {
    await copyFilesToServer(host)
  }

  // make sure server has been prepped, in a real script we might do this automatically
  ns.print(`Ensuring server ${target} is ready`)
  const ensureServerIsReady = (target) => {
    let testServer = ns.getServer(target)
    if (testServer.hackDifficulty !== testServer.minDifficulty || testServer.moneyAvailable !== testServer.moneyMax) {
      ns.tprint(JSON.stringify(testServer, null, 2))
      ns.tprint(`ERROR!  ${target} needs prepping!`)
      ns.exit()
    }
  }
  ensureServerIsReady(target)

  // used to calculate ram available
  const hostMaxRam = ns.getServerMaxRam(host)

  const EXIT = (message, errorObject) => {
    ns.tprint(`ERROR: ${message}`)
    obj.error = errorObject
    otherServers.forEach(x => ns.killall(x.hostname))
    ns.killall()
    ns.exit()
  }

  /**
   * If port has any messages available, process them
   */
  const processIncomingMessages = () => {
    let messages = []
    while (!handle.empty()) {
      messages[messages.length] = JSON.parse(handle.read())
    }
    while (!handle2.empty()) {
      messages[messages.length] = JSON.parse(handle2.read())
    }
    if (messages.length === 0) return

    // sort 'end' first, then by id
    messages.sort((a, b) => {
      if (a.message === 'end' && b.message !== 'end') return -1
      if (b.message === 'end' && a.message !== 'end') return 1
      return a.id - b.id
    })

    messages.forEach(msg => {
      obj.messages[obj.messages.length] = msg
      let { message, id, command, start, time, eEnd, end, result}  = msg
      let worker = workers[id]
      if (!worker) EXIT(`Got message for unknown worker ${id}`, {msg, workers})

      // ------------------------------ start message ------------------------------
      // { id, message: 'start', command: 'weak', start, time, eEnd }
      // Here we need to update our Worker with the new information and place
      // it into the processing array.
      if (message === 'start') {
        let index = findProcessing({ id, eEnd })
        if (compareWorkers({ id, eEnd }, processing[index]) === 0)  EXIT('got start message for worker already in array!', { msg, processing, workers })

        // insert into array at the right spot
        // DEBUG(`Inserting ${workerId} eEnd ${eEnd} at index ${index}`)
        // DEBUG(`Between ${processing[index-1]?.eEnd} and ${processing[index]?.eEnd}`)
        Object.assign(worker, { start, time, eEnd })
        processing = processing.slice(0, index).concat([worker]).concat(processing.slice(index))
        obj.processing = processing
        counts[command]++
      } else if (message === 'continue') {
        // this is for end and restart of 'weak' commands -- end and result are for previous run
        // { id, message: 'continue', command: 'weak', start, time, eEnd, end, result }
        
        // the first time we get a continue, disable scheduling new weak
        nextWeak = 0

        // create copy of worker with results for debug logging
        let workerCopy = {...worker, end, result}
        // obj.finished[obj.finished.length] = workerCopy

        // remove previous spot in processing with old eEnd
        let oldIndex = findProcessing(worker)
        processing = processing.slice(0, oldIndex).concat(processing.slice(oldIndex + 1))

        // update worker and insert into new position with new eEnd
        Object.assign(worker, { start, time, eEnd, end: null, result: null })
        let newIndex = findProcessing(worker)
        processing = processing.slice(0, newIndex).concat([worker]).concat(processing.slice(newIndex))

        // update debug object on window
        obj.processing = processing
      } else if (message === 'end') {
        // ------------------------------ end message ------------------------------
        // { id, message: 'end', command: 'grow', end, result }
        // Update end information and remove from processing array
        let index = findProcessing(worker)
        if (compareWorkers(worker, processing[index]) !== 0) EXIT(`got end message for worker missing from array!`, {msg, worker, index, processingLength: processing.length, processing: processing[index]})

        // delete worker from processing array
        processing = processing.slice(0, index).concat(processing.slice(index + 1))
        obj.processing = processing

        worker.end = end
        worker.result = result
        counts[command]--
        // obj.finished[obj.finished.length] = worker
        delete workers[id]
      } else {
        EXIT(`unknown message ${message}`, msg)
      }
    });
  }

  // we run weakens every 50ms until we get the first response saying
  // one has finished, then we set to 0

  // handle utilizing ram on other servers for weak scripts
  let otherServers = [{"hostname":"n00dles","maxRam":4},{"hostname":"foodnstuff","maxRam":16},{"hostname":"sigma-cosmetics","maxRam":16},{"hostname":"joesguns","maxRam":16},{"hostname":"hong-fang-tea","maxRam":16},{"hostname":"harakiri-sushi","maxRam":16},{"hostname":"iron-gym","maxRam":32},{"hostname":"zer0","maxRam":32},{"hostname":"nectar-net","maxRam":16},{"hostname":"max-hardware","maxRam":32},{"hostname":"CSEC","maxRam":8},{"hostname":"silver-helix","maxRam":64},{"hostname":"phantasy","maxRam":32},{"hostname":"omega-net","maxRam":32},{"hostname":"neo-net","maxRam":32},{"hostname":"netlink","maxRam":16},{"hostname":"avmnite-02h","maxRam":64},{"hostname":"the-hub","maxRam":64},{"hostname":"I.I.I.I","maxRam":64},{"hostname":"summit-uni","maxRam":16},{"hostname":"zb-institute","maxRam":32},{"hostname":"catalyst","maxRam":128},{"hostname":"rothman-uni","maxRam":128},{"hostname":"alpha-ent","maxRam":128},{"hostname":"millenium-fitness","maxRam":64},{"hostname":"lexo-corp","maxRam":32},{"hostname":"aevum-police","maxRam":64},{"hostname":"rho-construction","maxRam":16},{"hostname":"global-pharm","maxRam":16},{"hostname":"omnia","maxRam":64},{"hostname":"unitalife","maxRam":32},{"hostname":"univ-energy","maxRam":128},{"hostname":"solaris","maxRam":16},{"hostname":"titan-labs","maxRam":128},{"hostname":"run4theh111z","maxRam":512},{"hostname":"microdyne","maxRam":64},{"hostname":"fulcrumtech","maxRam":128},{"hostname":"helios","maxRam":64},{"hostname":"vitalife","maxRam":64},{"hostname":".","maxRam":16},{"hostname":"omnitek","maxRam":512},{"hostname":"blade","maxRam":128},{"hostname":"powerhouse-fitness","maxRam":16}]
  let usableServers = [...otherServers]
  // const report = () => {
  //   let otherRam = otherServers.reduce((t, x) => t + x.maxRam, 0)
  //   let otherWeakens = otherServers.reduce((t, x) => t + Math.trunc(x.maxRam / weakScriptRam), 0)
  //   let hackPercent = ns.formulas.hacking.hackPercent(ns.getServer(target), ns.getPlayer())
  //   let hackChance = ns.formulas.hacking.hackChance(ns.getServer(target), ns.getPlayer())
  //   let maxMoney = ns.getServerMaxMoney(target)
  //   let ramAvailable = ns.getServerMaxRam('home') + otherRam
  //   let homeRamAvailable = ns.getServerMaxRam('home') - ns.getServerUsedRam('home') + otherWeakens * weakScriptRam
  //   let batchRam = 12 * hackScriptRam  // one hacking slot has 12 hack threads
  //       + weakScriptRam * 5 // and will require 5 weaken threads because 5 hacks take the time of one weaken
  //       + (growScriptRam * 24) * 4 // and will require 96 grow threads, 24 for each hack and grows take 4x as long
  //       + (weakScriptRam * 2) * 4 * 5/4 // and 10 more weaken threads, 8 for the grows and take 5/4 the time of a grow
  //   let hackMoney = hackPercent * maxMoney * 12
  //   // let hackingTimeMs = Math.trunc(3600000 - ns.getWeakenTime(target))
  //   let hackingTimeMs = Math.trunc(3600000)
  //   let activeBatches = Math.trunc(homeRamAvailable / batchRam)
  //   let cycleCount = (hackingTimeMs - ns.getHackTime(target)) / ns.getHackTime(target)
  //   let totalMoney = cycleCount * activeBatches * hackMoney * hackChance
  //   ns.tprint(JSON.stringify({ otherRam, otherWeakens, hackPercent, hackChance,
  //     maxMoney: ns.nFormat(maxMoney, "$0.0a"),
  //     ramAvailable, homeRamAvailable,
  //     batchRam, hackingTimeMs,
  //     hackMoney: ns.nFormat(hackMoney, "$0.0a"),
  //     activeBatches, cycleCount,
  //     totalMoney: ns.nFormat(totalMoney, "$0.0a")
  //    }, null, 2))
  // }

  const report = () => {
    let otherRam = otherServers.reduce((t, x) => t + x.maxRam, 0)
    let otherWeakens = otherServers.reduce((t, x) => t + Math.trunc(x.maxRam / weakScriptRam), 0)
    let hackPercent = ns.formulas.hacking.hackPercent(ns.getServer(target), ns.getPlayer())
    let hackChance = ns.formulas.hacking.hackChance(ns.getServer(target), ns.getPlayer())
    let maxMoney = ns.getServerMaxMoney(target)
    let ramAvailable = ns.getServerMaxRam('home') + otherRam
    let homeRamAvailable = ns.getServerMaxRam('home') - ns.getServerUsedRam('home') + otherWeakens * weakScriptRam
    let batchRam = 24 * hackScriptRam  // one hacking slot has 12 hack threads
        + weakScriptRam * 5 // and will require 5 weaken threads because 5 hacks take the time of one weaken
        + (growScriptRam * 48) * 4 // and will require 96 grow threads, 24 for each hack and grows take 4x as long
        + (weakScriptRam * 4) * 4 * 5/4 // and 10 more weaken threads, 8 for the grows and take 5/4 the time of a grow
    let hackMoney = hackPercent * maxMoney * 24
    // let hackingTimeMs = Math.trunc(3600000 - ns.getWeakenTime(target))
    let hackingTimeMs = Math.trunc(3600000 - ns.getWeakenTime(target))
    let activeBatches = Math.trunc(homeRamAvailable / batchRam)
    let cycleCount = (hackingTimeMs - ns.getHackTime(target)) / ns.getHackTime(target)
    let totalMoney = cycleCount * activeBatches * hackMoney * hackChance
    ns.tprint(JSON.stringify({ otherRam, otherWeakens, hackPercent, hackChance,
      maxMoney: ns.nFormat(maxMoney, "$0.0a"),
      ramAvailable, homeRamAvailable,
      batchRam, hackingTimeMs,
      hackMoney: ns.nFormat(hackMoney, "$0.0a"),
      activeBatches, cycleCount,
      totalMoney: ns.nFormat(totalMoney, "$0.0a")
     }, null, 2))
  }

  // report()
  ns.exit()

  const copyScriptsToOtherServers = async () => {
    for (let i = 0; i < otherServers.length; i++) {
      copyFilesToServer(otherServers[i].hostname)
    }
  }

  await copyScriptsToOtherServers()

  const findOtherServer = (ram) => {
    while (usableServers.length > 0 && usableServers[0].maxRam < weakScriptRam) {
      usableServers = usableServers.slice(1) 
    }

    if (usableServers.length <= 0) return null
    usableServers[0].maxRam -= weakScriptRam
    return usableServers[0].hostname
  }

  /**
   * Create a new worker
   * @param {string} host Hostname to execute command on
   * @param {string} command One of 'weak', 'hack', 'grow'
   * @param {number} threads How many threads to use
   * @param {number} id Id (time)
   * @param {number} execTime Expected duration
   * @param {number} execEnd Expected end time
   */
   const createWorker = (host, command, threads, id, execTime, execEnd) => {
    if (workers[id]) return null

    /**
     * @type{Worker}
     */
    const worker = {
      id,
      command,
      start: null,
      time: null,
      eEnd: null,
      end: null,
      result: null,
      execStart: id,
      execEnd,
      execTime,
      host,
      pid: null,
    }

    workers[id] = worker
    const scriptFile = `/remote/${command}.js`
    worker.pid = ns.exec(scriptFile, host, threads, target, id, command, PORT, execTime)
    obj.started[obj.started.length] = worker
    if (!worker.pid) {
      EXIT(`could not exec() script`, {args: [scriptFile, host, threads, target, id, command, PORT], worker})  
    }
    return worker
  }

  ns.tprint(`Starting main loop at ${new Date().toLocaleTimeString()}`)
  ns.tprint(`    Expect results at ${new Date(new Date().valueOf() + ns.getWeakenTime(target)).toLocaleTimeString()}`)

  let nextWeak = new Date().valueOf()
  let firstHack = true // for special processing running first hack before first weaken

  // for debugging
  const DEBUG = (str) => {
    // ns.tprint(`${str}`)
  }

  let lastGrowCreatedAt = 0
  let lastHackCreatedAt = 0
  let expectedWeak = Math.ceil(ns.getWeakenTime(target) / WEAK_DELAY)
  // method is weak, weak, grow, weak, weak, grow with hack in between
  let possibleHacks = Math.ceil(ns.getHackTime(target) / (WEAK_DELAY  * 4))


  //----------------------------------------------------------------------------------------------------
  // main loop
  //----------------------------------------------------------------------------------------------------
  while (true) {
    processIncomingMessages()

    let ram = hostMaxRam - ns.getServerUsedRam(host)
    if (ram < hackScriptRam * 12) {
      EXIT('Not enough ram!  Tweak your settings...', {ram, hostMaxRam, hackScriptRam})
    }
    obj.stats = { time: new Date().toLocaleTimeString(), processing: processing.length, finished: obj.finished.length, hostMaxRam, ram, counts }

    // schedule weakens every 50ms until we receive our first finish
    if ((nextWeak != 0) && (new Date().valueOf() >= nextWeak)) {
      let duration = ns.getWeakenTime(target)
      let id = new Date().valueOf()
      let eEnd = id + duration

      // we can use other servers for weak
      let useHost = findOtherServer(weakScriptRam) || host
      if (createWorker(useHost, 'weak', 1, id, duration, eEnd)) {
        nextWeak += WEAK_DELAY
        await ns.sleep(10)
        DEBUG(`Created weak ${id} ending ${eEnd}`)
        continue
      }
    }

    // schedule grows only when there are two weakens guaranteed before
    // it and two weakens guaranteed after it, and reserve ram for enough
    // hacks so that we have two grows per hack.  We can schedule 8 times
    // as many grows (since we use two grow per hack) since hacks only
    // last 1/4 as long
    let missingHack = Math.max(possibleHacks - counts.hack, 0)
    let missingHackRam = missingHack * hackScriptRam * 12
    let missingWeak = Math.max(expectedWeak - counts.weak, 0)
    let missingWeakRam = missingWeak * weakScriptRam
    let missingRam = missingHackRam + missingWeakRam + (RAM_SAFETY_FACTOR * hackScriptRam * 12)
    obj.missing = { missingHack, missingHackRam, missingWeak, missingWeakRam, missingRam, ram, counts }
    if (ram >  missingRam + growScriptRam * 12) {
      let duration = ns.getGrowTime(target)
      let id = new Date().valueOf()
      let eEnd = id + duration

      let index = findProcessing({ eEnd, id })
      const previousTwoAreWeak = processing[index - 1]?.command === 'weak' && processing[index - 2]?.command === 'weak'
      const nextTwoAreWeak = processing[index]?.command === 'weak' && processing[index + 1]?.command === 'weak'
      if (previousTwoAreWeak && nextTwoAreWeak && lastGrowCreatedAt < id - 20) {
        lastGrowCreatedAt = id
        if (createWorker(host, 'grow', 12, id, duration, eEnd)) {
          await ns.sleep(10)
          DEBUG(`Creating grow ${id} ending ${eEnd} (processing[0] at ${processing[0].eEnd})`)
          DEBUG(`  Previous 10: ${processing.slice(index - 10, index).map(x => x.command).join(',')}`)
          DEBUG(`  Next 10    : ${processing.slice(index, index + 10).map(x => x.command).join(',')}`)
          continue
        } else {
          DEBUG(`COULD NOT CREATE GROW()`)
        }
      }
    }

    if (ram >= hackScriptRam * 12) {
      let duration = ns.getHackTime(target)
      let id = new Date().valueOf()
      let eEnd = id + duration

      let index = findProcessing({ eEnd, id })
      
      if (firstHack) {
        // on first hack we schedule within 200ms of first weaken
        if (processing.length > 0 && processing[0].eEnd - eEnd < 200 && processing[0].eEnd > eEnd) {
          if (createWorker(host, 'hack', 12, id, duration, eEnd)) {
            firstHack = false
            await ns.sleep(10)
            DEBUG(`Created FIRST hack ${id} ending ${eEnd} (processing[0] at ${processing[0].eEnd})`)
            DEBUG(`  Next 5    : ${processing.slice(0, 5).map(x => x.command).join(',')}`)
            continue
          }
        }
      } else {
        // ignore current for grow calculation if it is a grow
        // count previous grow until we reach beginning of list or another hack
        let pastGrows = 0
        for (let i = index - 1; i >= 0; i--) {
          let w = processing[i]
          if (w.command === 'hack') break
          if (w.command === 'grow' && Math.abs(w.eEnd - eEnd) > 15) pastGrows++
        }
        
        // count future grow until we reach end of list or another hack
        let futureGrows = 0
        for (let i = index; i < processing.length; i++) {
          let w = processing[i]
          if (w.command === 'hack') break
          if (w.command === 'grow' && Math.abs(w.eEnd - eEnd) > 15) futureGrows++
        }
        
        // skip current/previous for weaken find if it is within 20ms
        const timeDiffCurrent = Math.abs(processing[index]?.eEnd - eEnd)
        const timeDiffPrevious = Math.abs(processing[index - 1]?.eEnd - eEnd)
        const skipCurrent = timeDiffCurrent < 10 ? 1 : 0
        const skipPrevious = timeDiffPrevious < 2 ? 1 : 0
        const previousIsWeak = processing[index - 1]?.command === 'weak' && processing[index - 1 - skipPrevious]?.command === 'weak'
        const nextIsWeak = processing[index]?.command === 'weak' && processing[index + skipCurrent]?.command === 'weak'

        if (previousIsWeak && nextIsWeak && pastGrows >= 2 && futureGrows >= 2 && lastHackCreatedAt < id - 20 ) {
          lastHackCreatedAt = id
          if (createWorker(host, 'hack', 12, id, duration, eEnd)) {
            await ns.sleep(10)
            // DEBUG(`Creating hack ${id} ending ${eEnd}`)
            // DEBUG(`  Previous 10: ${processing.slice(index - 10, index).map(x => x.command).join(',')}`)
            // DEBUG(`  Next 10    : ${processing.slice(index, index + 10).map(x => x.command).join(',')}`)
            continue
          }
        }
      }
    }

    // didn't start anything, wait a little longer this time
    await ns.sleep(10)
  }
}
