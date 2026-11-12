/** Re-export so tests and `node test/fake-model.ts` keep the same entry. */
export { startFakeModel, type FakeModel } from '../server/scripted-model.ts'
import { startFakeModel } from '../server/scripted-model.ts'

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startFakeModel(Number(process.env.PORT ?? 18080))
  console.log(`scripted model listening at ${m.url}; start the server with MODEL_BASE_URL=${m.url}`)
}
