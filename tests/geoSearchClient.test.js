const { test, describe, mock, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')

describe('geoSearchClient', () => {
  describe('buildGeoSearchBody', () => {
    const { buildGeoSearchBody } = require('../src/geoSearchClient')

    test('builds correct request body', () => {
      const bbox = { latMin: 38.8, latMax: 38.9, lonMin: -0.2, lonMax: -0.1 }
      const body = buildGeoSearchBody(bbox)

      assert.strictEqual(body.dto.latitudeMin, 38.8)
      assert.strictEqual(body.dto.latitudeMax, 38.9)
      assert.strictEqual(body.dto.longitudeMin, -0.2)
      assert.strictEqual(body.dto.longitudeMax, -0.1)
      assert.strictEqual(body.language, 'en')
      assert.deepStrictEqual(body.dto.chargePointTypesCodes, ['P', 'R', 'I', 'N'])
      assert.deepStrictEqual(body.dto.socketStatus, [])
      assert.strictEqual(body.dto.advantageous, false)
    })
  })

  describe('validateGeoSearchResponse', () => {
    const { validateGeoSearchResponse } = require('../src/geoSearchClient')

    test('returns valid for correct response', () => {
      const response = { entidad: [{ cpId: 123 }] }
      const result = validateGeoSearchResponse(response)
      assert.strictEqual(result.valid, true)
      assert.strictEqual(result.reason, null)
    })

    test('returns valid for empty entidad array', () => {
      const response = { entidad: [] }
      const result = validateGeoSearchResponse(response)
      assert.strictEqual(result.valid, true)
    })

    test('returns invalid for null response', () => {
      const result = validateGeoSearchResponse(null)
      assert.strictEqual(result.valid, false)
      assert.ok(result.reason.includes('null'))
    })

    test('returns invalid for missing entidad', () => {
      const result = validateGeoSearchResponse({})
      assert.strictEqual(result.valid, false)
      assert.ok(result.reason.includes('not an array'))
    })

    test('returns invalid for non-array entidad', () => {
      const result = validateGeoSearchResponse({ entidad: 'not array' })
      assert.strictEqual(result.valid, false)
      assert.ok(result.reason.includes('not an array'))
    })
  })

  describe('fetchStationsInBoundingBox with mocked fetch', () => {
    let originalFetch

    beforeEach(() => {
      originalFetch = global.fetch
    })

    afterEach(() => {
      global.fetch = originalFetch
      delete require.cache[require.resolve('../src/geoSearchClient')]
    })

    test('returns stations array on success', async () => {
      const mockStations = [
        { cpId: 123, locationData: { cuprId: 456, latitude: 38.8, longitude: -0.1 } },
      ]

      global.fetch = mock.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ entidad: mockStations }),
        })
      )

      const { fetchStationsInBoundingBox } = require('../src/geoSearchClient')

      const result = await fetchStationsInBoundingBox({
        latMin: 38.8,
        latMax: 38.9,
        lonMin: -0.2,
        lonMax: -0.1,
      })

      assert.deepStrictEqual(result, mockStations)
    })

    test('returns empty array when no stations found', async () => {
      global.fetch = mock.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ entidad: [] }),
        })
      )

      const { fetchStationsInBoundingBox } = require('../src/geoSearchClient')

      const result = await fetchStationsInBoundingBox({
        latMin: 38.8,
        latMax: 38.9,
        lonMin: -0.2,
        lonMax: -0.1,
      })

      assert.deepStrictEqual(result, [])
    })

    test('returns null on HTTP error', async () => {
      global.fetch = mock.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Internal Server Error'),
        })
      )

      const { fetchStationsInBoundingBox } = require('../src/geoSearchClient')

      const result = await fetchStationsInBoundingBox({
        latMin: 38.8,
        latMax: 38.9,
        lonMin: -0.2,
        lonMax: -0.1,
      })

      assert.strictEqual(result, null)
    })

    test('returns null on network error', async () => {
      global.fetch = mock.fn(() => Promise.reject(new Error('Network error')))

      const { fetchStationsInBoundingBox } = require('../src/geoSearchClient')

      const result = await fetchStationsInBoundingBox({
        latMin: 38.8,
        latMax: 38.9,
        lonMin: -0.2,
        lonMax: -0.1,
      })

      assert.strictEqual(result, null)
    })

    test('returns null on invalid response structure', async () => {
      global.fetch = mock.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ invalid: 'data' }),
        })
      )

      const { fetchStationsInBoundingBox } = require('../src/geoSearchClient')

      const result = await fetchStationsInBoundingBox({
        latMin: 38.8,
        latMax: 38.9,
        lonMin: -0.2,
        lonMax: -0.1,
      })

      assert.strictEqual(result, null)
    })

    test('sends correct request body', async () => {
      global.fetch = mock.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ entidad: [] }),
        })
      )

      const { fetchStationsInBoundingBox } = require('../src/geoSearchClient')

      await fetchStationsInBoundingBox({
        latMin: 38.812,
        latMax: 38.865,
        lonMin: -0.156,
        lonMax: -0.075,
      })

      const [, options] = global.fetch.mock.calls[0].arguments
      const body = JSON.parse(options.body)

      assert.strictEqual(body.dto.latitudeMin, 38.812)
      assert.strictEqual(body.dto.latitudeMax, 38.865)
      assert.strictEqual(body.dto.longitudeMin, -0.156)
      assert.strictEqual(body.dto.longitudeMax, -0.075)
    })

    test('sends correct headers', async () => {
      global.fetch = mock.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ entidad: [] }),
        })
      )

      const { fetchStationsInBoundingBox } = require('../src/geoSearchClient')

      await fetchStationsInBoundingBox({
        latMin: 38.8,
        latMax: 38.9,
        lonMin: -0.2,
        lonMax: -0.1,
      })

      const [, options] = global.fetch.mock.calls[0].arguments

      assert.strictEqual(options.headers['content-type'], 'application/json')
      assert.ok(options.headers.referer.includes('iberdrola.es'))
      assert.strictEqual(options.headers['x-requested-with'], 'XMLHttpRequest')
    })
  })
})
