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
    console.error(`::error::Iberdrola API did not respond for cuprId=${CUPR_ID}. The API may be down or rate-limiting.`)
    console.log('SKIPPING DB inserts')
    process.exitCode = 1
    return
  }

  if (!Array.isArray(detailJson.entidad) || detailJson.entidad.length === 0) {
    console.log(`::warning::Station cuprId=${CUPR_ID} not found in Iberdrola API — the station may be decommissioned or temporarily unavailable. This is not an error.`)
    return
  }

  const validation = validateResponse(detailJson)
  if (!validation.valid) {
    console.error(`::error::Malformed data from Iberdrola for cuprId=${CUPR_ID}: ${validation.reason}`)
    console.log('SKIPPING DB inserts')
    process.exitCode = 1
    return
  }

  const [snapshotResult, metadataResult] = await Promise.all([
    saveSnapshot(detailJson),
    saveStationMetadata(detailJson),
  ])

  if (!snapshotResult.success) {
    console.error(`::error::Failed to save snapshot for cuprId=${CUPR_ID}. Check Supabase connectivity and RLS policies.`)
    process.exitCode = 1
  }

  if (!metadataResult.success) {
    console.error(`::error::Failed to save station metadata for cuprId=${CUPR_ID}. Check Supabase connectivity and RLS policies.`)
    process.exitCode = 1
  }

  if (snapshotResult.success && metadataResult.success) {
    console.log(`DONE — cuprId=${CUPR_ID} data saved successfully`)
  }
}

main().catch((err) => {
  console.error('UNHANDLED ERROR IN MAIN', err)
  process.exitCode = 1
})
