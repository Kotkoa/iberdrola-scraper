const { fetchDatos } = require('./src/iberdrolaClient')
const {
  validateResponse,
  saveRaw,
  saveParsed,
  saveStationMetadata,
} = require('./src/supabaseService')

const CUPR_ID = 144569

/**
 * Main orchestrator: fetches data and persists to Supabase
 * @returns {Promise<void>}
 */
async function main() {
  console.log('START FETCH getDatosPuntoRecarga, cuprId =', CUPR_ID)

  const detailJson = await fetchDatos(CUPR_ID)

  // Check that data is received
  if (!detailJson) {
    console.error('FETCH FAILED: no data received')
    console.log('SKIPPING DB inserts')
    process.exitCode = 1
    return
  }

  // Validate response structure
  const validation = validateResponse(detailJson)
  if (!validation.valid) {
    console.error('VALIDATION FAILED:', validation.reason)
    console.log('SKIPPING DB inserts')
    process.exitCode = 1
    return
  }

  const rawResult = await saveRaw(detailJson)
  if (!rawResult.success) {
    console.error('FAILED TO SAVE RAW DATA')
    process.exitCode = 1
  }

  const parsedResult = await saveParsed(detailJson)
  if (!parsedResult.success) {
    console.error('FAILED TO SAVE PARSED DATA')
    process.exitCode = 1
  }

  const metadataResult = await saveStationMetadata(detailJson)
  if (!metadataResult.success) {
    console.error('FAILED TO SAVE STATION METADATA')
    process.exitCode = 1
  }

  if (rawResult.success && parsedResult.success && metadataResult.success) {
    console.log('DONE — all data saved successfully')
  }
}

main().catch((err) => {
  console.error('UNHANDLED ERROR IN MAIN', err)
  process.exitCode = 1
})
