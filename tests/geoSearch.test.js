const { test, describe } = require('node:test')
const assert = require('node:assert')

const {
  validateInputs,
  buildStationPayload,
  MAX_RADIUS_KM,
  KM_PER_DEGREE_LAT,
} = require('../src/geoSearch')

describe('geoSearch', () => {
  describe('validateInputs', () => {
    test('returns valid for correct bbox', () => {
      const bbox = { latMin: 38.8, latMax: 38.9, lonMin: -0.2, lonMax: -0.1 }
      const result = validateInputs(bbox)
      assert.strictEqual(result.valid, true)
      assert.strictEqual(result.reason, null)
    })

    test('returns invalid for NaN coordinates', () => {
      const bbox = { latMin: NaN, latMax: 38.9, lonMin: -0.2, lonMax: -0.1 }
      const result = validateInputs(bbox)
      assert.strictEqual(result.valid, false)
      assert.ok(result.reason.includes('Invalid number'))
    })

    test('returns invalid when lat_min >= lat_max', () => {
      const bbox = { latMin: 39, latMax: 38, lonMin: -0.2, lonMax: -0.1 }
      const result = validateInputs(bbox)
      assert.strictEqual(result.valid, false)
      assert.ok(result.reason.includes('lat_min must be less than lat_max'))
    })

    test('returns invalid when lon_min >= lon_max', () => {
      const bbox = { latMin: 38, latMax: 39, lonMin: -0.1, lonMax: -0.2 }
      const result = validateInputs(bbox)
      assert.strictEqual(result.valid, false)
      assert.ok(result.reason.includes('lon_min must be less than lon_max'))
    })

    test('returns invalid for latitude out of range', () => {
      const bbox = { latMin: -100, latMax: 38.9, lonMin: -0.2, lonMax: -0.1 }
      const result = validateInputs(bbox)
      assert.strictEqual(result.valid, false)
      assert.ok(result.reason.includes('between -90 and 90'))
    })

    test('returns invalid for longitude out of range', () => {
      const bbox = { latMin: 38, latMax: 39, lonMin: -200, lonMax: -0.1 }
      const result = validateInputs(bbox)
      assert.strictEqual(result.valid, false)
      assert.ok(result.reason.includes('between -180 and 180'))
    })

    test('returns invalid when bbox exceeds 25km radius', () => {
      const bbox = { latMin: 38, latMax: 39, lonMin: -0.2, lonMax: -0.1 }
      const result = validateInputs(bbox)
      assert.strictEqual(result.valid, false)
      assert.ok(result.reason.includes('exceeds maximum size'))
    })

    test('returns valid for bbox within 25km radius', () => {
      const latDelta = (MAX_RADIUS_KM * 2) / KM_PER_DEGREE_LAT
      const bbox = {
        latMin: 38.5,
        latMax: 38.5 + latDelta * 0.9,
        lonMin: -0.2,
        lonMax: -0.1,
      }
      const result = validateInputs(bbox)
      assert.strictEqual(result.valid, true)
    })

    test('returns invalid when lat_min equals lat_max', () => {
      const bbox = { latMin: 38.5, latMax: 38.5, lonMin: -0.2, lonMax: -0.1 }
      const result = validateInputs(bbox)
      assert.strictEqual(result.valid, false)
      assert.ok(result.reason.includes('lat_min must be less'))
    })
  })

  describe('buildStationPayload', () => {
    test('builds payload from complete station data', () => {
      const station = {
        cpId: 140671,
        locationData: {
          cuprId: 144569,
          cuprName: 'Paseo Cervantes 10',
          latitude: 38.839266,
          longitude: -0.120815,
          situationCode: 'OPER',
          supplyPointData: {
            cpAddress: {
              streetName: 'Cervantes',
              streetNum: '10',
              townName: 'PEGO',
              regionName: 'ALICANTE',
            },
          },
        },
        cpStatus: { statusCode: 'AVAILABLE' },
        socketNum: 2,
      }

      const payload = buildStationPayload(station)

      assert.strictEqual(payload.cp_id, 140671)
      assert.strictEqual(payload.cupr_id, 144569)
      assert.strictEqual(payload.name, 'Paseo Cervantes 10')
      assert.strictEqual(payload.latitude, 38.839266)
      assert.strictEqual(payload.longitude, -0.120815)
      assert.strictEqual(payload.address_full, 'Cervantes, 10, PEGO, ALICANTE')
      assert.strictEqual(payload.overall_status, 'AVAILABLE')
      assert.strictEqual(payload.total_ports, 2)
      assert.strictEqual(payload.situation_code, 'OPER')
      assert.ok(payload.updated_at)
    })

    test('handles missing optional fields', () => {
      const station = {
        cpId: 140671,
        locationData: {
          cuprId: 144569,
          cuprName: 'Test Station',
          latitude: 38.839,
          longitude: -0.120,
        },
      }

      const payload = buildStationPayload(station)

      assert.strictEqual(payload.cp_id, 140671)
      assert.strictEqual(payload.address_full, null)
      assert.strictEqual(payload.overall_status, null)
      assert.strictEqual(payload.total_ports, null)
      assert.strictEqual(payload.situation_code, null)
    })

    test('handles null locationData gracefully', () => {
      const station = { cpId: 140671 }
      const payload = buildStationPayload(station)

      assert.strictEqual(payload.cp_id, 140671)
      assert.strictEqual(payload.cupr_id, null)
      assert.strictEqual(payload.name, null)
    })
  })
})
