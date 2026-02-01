const { fetchDatos } = require('./src/iberdrolaClient')
const {
  assertConfig,
  validateResponse,
  saveStationMetadata,
  saveSnapshot,
} = require('./src/supabaseService')

const CUPR_ID = parseInt(process.env.CUPR_ID, 10) || 144569

/**
 * Main orchestrator: fetches data and persists to Supabase
 * @returns {Promise<void>}
 */
async function main() {
  assertConfig()

  console.log('START FETCH getDatosPuntoRecarga, cuprId =', CUPR_ID)

  const detailJson = await fetchDatos(CUPR_ID)

  if (!detailJson) {
    console.error('FETCH FAILED: no data received')
    console.log('SKIPPING DB inserts')
    process.exitCode = 1
    return
  }

  const validation = validateResponse(detailJson)
  if (!validation.valid) {
    console.error('VALIDATION FAILED:', validation.reason)
    console.log('SKIPPING DB inserts')
    process.exitCode = 1
    return
  }

  const snapshotResult = await saveSnapshot(detailJson)
  if (!snapshotResult.success) {
    console.error('FAILED TO SAVE SNAPSHOT')
    process.exitCode = 1
  }

  const metadataResult = await saveStationMetadata(detailJson)
  if (!metadataResult.success) {
    console.error('FAILED TO SAVE STATION METADATA')
    process.exitCode = 1
  }

  if (snapshotResult.success && metadataResult.success) {
    console.log('DONE — all data saved successfully')
  }
}

main().catch((err) => {
  console.error('UNHANDLED ERROR IN MAIN', err)
  process.exitCode = 1
})
