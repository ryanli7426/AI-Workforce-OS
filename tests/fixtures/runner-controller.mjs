// A short-lived control-plane process: its detached Runner must outlive this process.
import { pathToFileURL } from 'node:url'
const [clientPath, root, workerPath, rawSpec] = process.argv.slice(2)
const { RunnerClient } = await import(pathToFileURL(clientPath).href)
const client = new RunnerClient({ root, workerPath })
const state = await client.start(JSON.parse(rawSpec))
process.stdout.write(JSON.stringify({ executionId: state.executionId, runnerPid: state.runnerPid }))
