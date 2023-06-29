const exec = require('child_process').exec
const fs = require('fs')
const path = require('path')
const stream = require('stream')
const { promisify } = require('util')

const area = require('@mapbox/geojson-area')
const geojsonhint = require('@mapbox/geojsonhint')
const bbox = require('@turf/bbox').default
const helpers = require('@turf/helpers')
const multiPolygon = helpers.multiPolygon
const polygon = helpers.polygon
const asynclib = require('async')
const got = require('got')
const jsts = require('jsts')
const rimraf = require('rimraf')
const overpass = require('query-overpass')
const yargs = require('yargs')

const FeatureWriterStream = require('./util/featureWriterStream')
const ProgressStats = require('./util/progressStats')

let osmBoundarySources = require('./osmBoundarySources.json')
let zoneCfg = require('./timezones.json')
const expectedZoneOverlaps = require('./expectedZoneOverlaps.json')

const fiveYearsAgo = (new Date()).getFullYear()

const argv = yargs
  .option('cutoff_years', {
    description: 'Generate additional release files for timezones with the same data after a certain cutoff year.',
    default: [fiveYearsAgo],
    type: 'array'
  })
  .option('dist_dir', {
    description: 'Set the dist location, for the generated release files',
    default: './dist',
    type: 'string'
  })
  .option('downloads_dir', {
    description: 'Set the download location for features from OpenStreetMap',
    default: './downloads',
    type: 'string'
  })
  .option('excluded_zones', {
    description: 'Exclude specified zones',
    type: 'array'
  })
  .option('included_zones', {
    description: 'Include specified zones',
    type: 'array'
  })
  .option('skip_analyze_diffs', {
    description: 'Skip analysis of diffs between versions',
    type: 'boolean'
  })
  .option('skip_analyze_osm_tz_diffs', {
    description: 'Skip analysis of diffs between timezone-boundary-builder output and raw OSM timezone relations',
    type: 'boolean'
  })
  .option('skip_shapefile', {
    description: 'Skip shapefile creation',
    type: 'boolean'
  })
  .option('skip_validation', {
    description: 'Skip validation',
    type: 'boolean'
  })
  .option('skip_zip', {
    description: 'Skip zip creation',
    type: 'boolean'
  })
  .option('working_dir', {
    description: 'Set the working files location for temporary / intermediate files',
    default: './working',
    type: 'string'
  })
  .help()
  .strict()
  .alias('help', 'h')
  .argv

// Resolve the arguments with paths so relative paths become absolute.
const downloadsDir = path.resolve(argv.downloads_dir)
const distDir = path.resolve(argv.dist_dir)
const workingDir = path.resolve(argv.working_dir)

// allow building of only a specified zones
let includedZones = []
let excludedZones = []
if (argv.included_zones || argv.excluded_zones) {
  if (argv.included_zones) {
    const newZoneCfg = {}
    includedZones = argv.included_zones
    includedZones.forEach((zoneName) => {
      newZoneCfg[zoneName] = zoneCfg[zoneName]
    })
    zoneCfg = newZoneCfg
  }
  if (argv.excluded_zones) {
    const newZoneCfg = {}
    excludedZones = argv.excluded_zones
    Object.keys(zoneCfg).forEach((zoneName) => {
      if (!excludedZones.includes(zoneName)) {
        newZoneCfg[zoneName] = zoneCfg[zoneName]
      }
    })
    zoneCfg = newZoneCfg
  }

  // filter out unneccessary downloads
  const newOsmBoundarySources = {}
  Object.keys(zoneCfg).forEach((zoneName) => {
    zoneCfg[zoneName].forEach((op) => {
      if (op.source === 'overpass') {
        newOsmBoundarySources[op.id] = osmBoundarySources[op.id]
      }
    })
  })

  osmBoundarySources = newOsmBoundarySources
}

const geoJsonReader = new jsts.io.GeoJSONReader()
const geoJsonWriter = new jsts.io.GeoJSONWriter()
const precisionModel = new jsts.geom.PrecisionModel(1000000)
const precisionReducer = new jsts.precision.GeometryPrecisionReducer(precisionModel)
const finalZones = {}
let lastReleaseJSONfile
const minRequestGap = 8
let curRequestGap = 8
const bufferDistance = 0.01

function safeMkdir (dirname, callback) {
  fs.mkdir(dirname, function (err) {
    if (err && err.code === 'EEXIST') {
      callback()
    } else {
      callback(err)
    }
  })
}

function debugGeo (
  op,
  a,
  b,
  reducePrecision,
  bufferAfterPrecisionReduction
) {
  let result

  if (reducePrecision) {
    a = precisionReducer.reduce(a)
    b = precisionReducer.reduce(b)
  }

  try {
    switch (op) {
      case 'union':
        result = a.union(b)
        break
      case 'intersection':
        result = a.intersection(b)
        break
      case 'intersects':
        result = a.intersects(b)
        break
      case 'diff':
        result = a.difference(b)
        break
      default:
        throw new Error('invalid op: ' + op)
    }
  } catch (e) {
    if (e.name === 'TopologyException') {
      if (reducePrecision) {
        if (bufferAfterPrecisionReduction) {
          console.log('Encountered TopologyException, retry with buffer increase')
          return debugGeo(
            op,
            a.buffer(bufferDistance),
            b.buffer(bufferDistance),
            true,
            bufferAfterPrecisionReduction
          )
        } else {
          throw new Error('Encountered TopologyException after reducing precision')
        }
      } else {
        console.log('Encountered TopologyException, retry with GeometryPrecisionReducer')
        return debugGeo(op, a, b, true, bufferAfterPrecisionReduction)
      }
    }
    console.log('op err')
    console.log(e)
    console.log(e.stack)
    fs.writeFileSync('debug_' + op + '_a.json', JSON.stringify(geoJsonWriter.write(a)))
    fs.writeFileSync('debug_' + op + '_b.json', JSON.stringify(geoJsonWriter.write(b)))
    throw e
  }

  return result
}

function fetchIfNeeded (file, superCallback, downloadCallback, fetchFn) {
  // check for file that got downloaded
  fs.stat(file, function (err) {
    if (!err) {
      // file found, skip download steps
      return superCallback()
    }
    // check for manual file that got fixed and needs validation
    const fixedFile = file.replace('.json', '_fixed.json')
    fs.stat(fixedFile, function (err) {
      if (!err) {
        // file found, return fixed file
        return downloadCallback(null, require(fixedFile))
      }
      // no manual fixed file found, download from overpass
      fetchFn()
    })
  })
}

function geoJsonToGeom (geoJson) {
  try {
    return geoJsonReader.read(JSON.stringify(geoJson))
  } catch (e) {
    console.error('error converting geojson to geometry')
    fs.writeFileSync('debug_geojson_read_error.json', JSON.stringify(geoJson))
    throw e
  }
}

function geomToGeoJson (geom) {
  return geoJsonWriter.write(geom)
}

function geomToGeoJsonString (geom) {
  return JSON.stringify(geoJsonWriter.write(geom))
}

const downloadProgress = new ProgressStats(
  'Downloading',
  Object.keys(osmBoundarySources).length
)

const downloadOSMZoneProgress = new ProgressStats(
  'Downloading OSM Zone',
  Object.keys(zoneCfg).length
)

/**
 * Download something from overpass and convert it into GeoJSON.
 *
 * @param  {string} queryName  Name of the query (for debugging purposes)
 * @param  {object} overpassConfig Config used to build overpass query
 * @param  {string} filename  Filename to save result to
 * @param  {function} overpassDownloadCallback  The callback to call when done
 */
function downloadFromOverpass (
  queryName,
  overpassConfig,
  filename,
  overpassDownloadCallback
) {
  let query = '[out:json][timeout:60];('
  if (overpassConfig.way) {
    query += 'way'
  } else {
    query += 'relation'
  }

  const queryKeys = Object.keys(overpassConfig)

  for (let i = queryKeys.length - 1; i >= 0; i--) {
    const k = queryKeys[i]
    if (k === 'way') continue
    const v = overpassConfig[k]

    query += '["' + k + '"="' + v + '"]'
  }

  query += ';);out body;>;out meta qt;'

  // query-overpass sometimes makes duplicate callbacks, so keep track of the callbacks and
  // only do a next action once.
  let curOverpassQueryAttempt = 0
  const overpassAttempts = {}

  asynclib.auto({
    fetchFromOverpassIfNeeded: function (cb) {
      console.log('downloading from overpass')
      fetchIfNeeded(filename, overpassDownloadCallback, cb, function () {
        const overpassResponseHandler = function (err, data, overpassAttempt) {
          if (overpassAttempts[overpassAttempt]) {
            // Skip duplicate callback
            return
          }
          overpassAttempts[overpassAttempt] = true
          if (err) {
            console.log(err)
            console.log('Increasing overpass request gap')
            curRequestGap *= 2
            makeQuery()
          } else {
            console.log('Success, decreasing overpass request gap')
            curRequestGap = Math.max(minRequestGap, curRequestGap / 2)
            cb(null, data)
          }
        }
        const makeQuery = function () {
          console.log('waiting ' + curRequestGap + ' seconds')
          setTimeout(function () {
            curOverpassQueryAttempt++
            overpass(
              query,
              (err, data) => overpassResponseHandler(err, data, curOverpassQueryAttempt),
              { flatProperties: true }
            )
          }, curRequestGap * 1000)
        }
        makeQuery()
      })
    },
    validateOverpassResult: ['fetchFromOverpassIfNeeded', function (results, cb) {
      const data = results.fetchFromOverpassIfNeeded
      if (!data.features) {
        const err = new Error(`Invalid geojson from overpass for query: ${queryName}`)
        return cb(err)
      }
      if (data.features.length === 0) {
        console.error('No data for the following query:')
        console.error(query)
        console.error('To read more about this error, please visit https://git.io/vxKQL')
        return cb(new Error('No data found for from overpass query'))
      }
      cb()
    }],
    saveSingleMultiPolygon: ['validateOverpassResult', function (results, cb) {
      const data = results.fetchFromOverpassIfNeeded
      let combined

      // union all multi-polygons / polygons into one
      for (let i = data.features.length - 1; i >= 0; i--) {
        const curOsmGeom = data.features[i].geometry
        const curOsmProps = data.features[i].properties
        if (
          (curOsmGeom.type === 'Polygon' || curOsmGeom.type === 'MultiPolygon') &&
          curOsmProps.type === 'boundary' // need to make sure enclaves aren't unioned
        ) {
          console.log('combining border')
          let errors = geojsonhint.hint(curOsmGeom)
          if (errors && errors.length > 0) {
            const stringifiedGeojson = JSON.stringify(curOsmGeom, null, 2)
            errors = geojsonhint.hint(stringifiedGeojson)
            console.error('Invalid geojson received in Overpass Result')
            console.error('Overpass query: ' + query)
            const problemFilename = `${queryName}_convert_to_geom_error.json`
            fs.writeFileSync(problemFilename, stringifiedGeojson)
            console.error('saved problem file to ' + problemFilename)
            console.error('To read more about this error, please visit https://git.io/vxKQq')
            return cb(errors)
          }
          let curGeom
          try {
            curGeom = geoJsonToGeom(curOsmGeom)
          } catch (e) {
            console.error('error converting overpass result to geojson')
            console.error(e)

            fs.writeFileSync(
              `${queryName}_convert_to_geom_error-all-features.json`,
              JSON.stringify(data)
            )
            return cb(e)
          }
          if (!combined) {
            combined = curGeom
          } else {
            combined = debugGeo('union', curGeom, combined)
          }
        }
      }
      try {
        fs.writeFile(filename, geomToGeoJsonString(combined), cb)
      } catch (e) {
        console.error('error writing combined border to geojson')
        fs.writeFileSync(
          queryName + '_combined_border_convert_to_geom_error.json',
          JSON.stringify(data)
        )
        return cb(e)
      }
    }]
  }, overpassDownloadCallback)
}

function downloadOsmBoundary (boundaryId, boundaryCallback) {
  const boundaryFilename = downloadsDir + '/' + boundaryId + '.json'

  downloadProgress.beginTask(`getting data for ${boundaryId}`, true)

  downloadFromOverpass(
    boundaryId,
    osmBoundarySources[boundaryId],
    boundaryFilename,
    boundaryCallback
  )
}

function downloadOsmTimezoneBoundary (tzId, boundaryCallback) {
  const tzBoundayName = `${tzId.replace(/\//g, '-')}-tz`
  const boundaryFilename = downloadsDir + '/' + tzBoundayName + '.json'

  downloadOSMZoneProgress.beginTask(`getting data for ${tzBoundayName}`, true)

  downloadFromOverpass(
    tzBoundayName,
    { timezone: tzId },
    boundaryFilename,
    err => {
      if (err) {
        // assume no data or unparseable data, write a null island
        fs.writeFile(
          boundaryFilename,
          JSON.stringify(
            {
              type: 'Polygon',
              coordinates: [
                [[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1], [-0.1, -0.1]]
              ]
            }
          ),
          boundaryCallback
        )
      } else {
        boundaryCallback()
      }
    }
  )
}

function getFinalTzOutputFilename (tzid) {
  return workingDir + '/' + tzid.replace(/\//g, '__') + '.json'
}

/**
 * Get the geometry of the requested source data
 *
 * @return {Object} geom  The geometry of the source
 * @param {Object} source  An object representing the data source
 *   must have `source` key and then either:
 *     - `id` if from a file
 *     - `id` if from a file
 */
function getDataSource (source) {
  let geoJson
  if (source.source === 'overpass') {
    geoJson = require(downloadsDir + '/' + source.id + '.json')
  } else if (source.source === 'manual-polygon') {
    geoJson = polygon(source.data).geometry
  } else if (source.source === 'manual-multipolygon') {
    geoJson = multiPolygon(source.data).geometry
  } else if (source.source === 'final') {
    geoJson = require(getFinalTzOutputFilename(source.id))
  } else {
    const err = new Error('unknown source: ' + source.source)
    throw err
  }
  return geoJsonToGeom(geoJson)
}

/**
 * Post process created timezone boundary.
 * - remove small holes and exclaves
 * - reduce geometry precision
 *
 * @param  {Geometry} geom  The jsts geometry of the timezone
 * @param  {boolean} returnAsObject if true, return as object, otherwise return stringified
 * @return {Object|String}         geojson as object or stringified
 */
function postProcessZone (geom, returnAsObject) {
  // reduce precision of geometry
  const geojson = geomToGeoJson(precisionReducer.reduce(geom))

  // iterate through all polygons
  const filteredPolygons = []
  let allPolygons = geojson.coordinates
  if (geojson.type === 'Polygon') {
    allPolygons = [geojson.coordinates]
  }

  allPolygons.forEach((curPolygon, idx) => {
    // remove any polygon with very small area
    const polygonFeature = polygon(curPolygon)
    const polygonArea = area.geometry(polygonFeature.geometry)

    if (polygonArea < 1) return

    // find all holes
    const filteredLinearRings = []

    curPolygon.forEach((curLinearRing, lrIdx) => {
      if (lrIdx === 0) {
        // always keep first linearRing
        filteredLinearRings.push(curLinearRing)
      } else {
        const polygonFromLinearRing = polygon([curLinearRing])
        const linearRingArea = area.geometry(polygonFromLinearRing.geometry)

        // only include holes with relevant area
        if (linearRingArea > 1) {
          filteredLinearRings.push(curLinearRing)
        }
      }
    })

    filteredPolygons.push(filteredLinearRings)
  })

  // recompile to geojson string
  const newGeojson = {
    type: geojson.type
  }

  if (geojson.type === 'Polygon') {
    newGeojson.coordinates = filteredPolygons[0]
  } else {
    newGeojson.coordinates = filteredPolygons
  }

  return returnAsObject ? newGeojson : JSON.stringify(newGeojson)
}

const buildingProgress = new ProgressStats(
  'Building',
  Object.keys(zoneCfg).length
)

function makeTimezoneBoundary (tzid, callback) {
  buildingProgress.beginTask(`makeTimezoneBoundary for ${tzid}`, true)

  const ops = zoneCfg[tzid]
  let geom

  asynclib.eachSeries(ops, function (task, cb) {
    const taskData = getDataSource(task)
    console.log('-', task.op, task.id)
    if (task.op === 'init') {
      geom = taskData
    } else if (task.op === 'intersect') {
      geom = debugGeo('intersection', geom, taskData)
    } else if (task.op === 'difference') {
      geom = debugGeo('diff', geom, taskData)
    } else if (task.op === 'difference-reverse-order') {
      geom = debugGeo('diff', taskData, geom)
    } else if (task.op === 'union') {
      geom = debugGeo('union', geom, taskData)
    } else {
      const err = new Error('unknown op: ' + task.op)
      return cb(err)
    }
    cb()
  },
  function (err) {
    if (err) { return callback(err) }
    fs.writeFile(getFinalTzOutputFilename(tzid),
      postProcessZone(geom),
      callback)
  })
}

function loadFinalZonesIntoMemory () {
  console.log('load zones into memory')
  const zones = Object.keys(zoneCfg)
  let tzid

  for (let i = 0; i < zones.length; i++) {
    tzid = zones[i]
    finalZones[tzid] = getDataSource({ source: 'final', id: tzid })
  }
}

function roundDownToTenth (n) {
  return Math.floor(n * 10) / 10
}

function roundUpToTenth (n) {
  return Math.ceil(n * 10) / 10
}

function formatBounds (bounds) {
  let boundsStr = '['
  boundsStr += roundDownToTenth(bounds[0]) + ', '
  boundsStr += roundDownToTenth(bounds[1]) + ', '
  boundsStr += roundUpToTenth(bounds[2]) + ', '
  boundsStr += roundUpToTenth(bounds[3]) + ']'
  return boundsStr
}

function validateTimezoneBoundaries () {
  const numZones = Object.keys(zoneCfg).length
  const validationProgress = new ProgressStats(
    'Validation',
    numZones * (numZones + 1) / 2
  )

  console.log('do validation... this may take a few minutes')
  let allZonesOk = true
  const zones = Object.keys(zoneCfg)
  let lastPct = 0
  let compareTzid, tzid, zoneGeom

  for (let i = 0; i < zones.length; i++) {
    tzid = zones[i]
    zoneGeom = finalZones[tzid]

    for (let j = i + 1; j < zones.length; j++) {
      const curPct = Math.floor(validationProgress.getPercentage())
      if (curPct % 10 === 0 && curPct !== lastPct) {
        validationProgress.printStats('Validating zones', true)
        lastPct = curPct
      }
      compareTzid = zones[j]

      const compareZoneGeom = finalZones[compareTzid]

      let intersects = false
      try {
        intersects = debugGeo('intersects', zoneGeom, compareZoneGeom)
      } catch (e) {
        console.warn('warning, encountered intersection error with zone ' + tzid + ' and ' + compareTzid)
      }
      if (intersects) {
        const intersectedGeom = debugGeo('intersection', zoneGeom, compareZoneGeom)
        const intersectedArea = intersectedGeom.getArea()

        if (intersectedArea > 0.0001) {
          // check if the intersected area(s) are one of the expected areas of overlap
          const allowedOverlapBounds = expectedZoneOverlaps[`${tzid}-${compareTzid}`] || expectedZoneOverlaps[`${compareTzid}-${tzid}`]
          const overlapsGeoJson = geoJsonWriter.write(intersectedGeom)

          // these zones are allowed to overlap in certain places, make sure the
          // found overlap(s) all fit within the expected areas of overlap
          if (allowedOverlapBounds) {
            // if the overlaps are a multipolygon, make sure each individual
            // polygon of overlap fits within at least one of the expected
            // overlaps
            let overlapsPolygons
            switch (overlapsGeoJson.type) {
              case 'MultiPolygon':
                overlapsPolygons = overlapsGeoJson.coordinates.map(
                  polygonCoords => ({
                    coordinates: polygonCoords,
                    type: 'Polygon'
                  })
                )
                break
              case 'Polygon':
                overlapsPolygons = [overlapsGeoJson]
                break
              case 'GeometryCollection':
                overlapsPolygons = []
                overlapsGeoJson.geometries.forEach(geom => {
                  if (geom.type === 'Polygon') {
                    overlapsPolygons.push(geom)
                  } else if (geom.type === 'MultiPolygon') {
                    geom.coordinates.forEach(polygonCoords => {
                      overlapsPolygons.push({
                        coordinates: polygonCoords,
                        type: 'Polygon'
                      })
                    })
                  }
                })
                break
              default:
                console.error('unexpected geojson overlap type')
                console.log(overlapsGeoJson)
                break
            }

            let allOverlapsOk = true
            overlapsPolygons.forEach((polygon, idx) => {
              const bounds = bbox(polygon)
              const polygonArea = area.geometry(polygon)
              if (
                polygonArea > 10 && // ignore small polygons
                !allowedOverlapBounds.some(allowedBounds =>
                  allowedBounds.bounds[0] <= bounds[0] && // minX
                    allowedBounds.bounds[1] <= bounds[1] && // minY
                    allowedBounds.bounds[2] >= bounds[2] && // maxX
                    allowedBounds.bounds[3] >= bounds[3] // maxY
                )
              ) {
                console.error(`Unexpected intersection (${polygonArea} area) with bounds: ${formatBounds(bounds)}`)
                allOverlapsOk = false
              }
            })

            if (allOverlapsOk) continue
          }

          // at least one unexpected overlap found, output an error and write debug file
          console.error('Validation error: ' + tzid + ' intersects ' + compareTzid + ' area: ' + intersectedArea)
          const debugFilename = tzid.replace(/\//g, '-') + '-' + compareTzid.replace(/\//g, '-') + '-overlap.json'
          fs.writeFileSync(
            debugFilename,
            JSON.stringify(overlapsGeoJson)
          )
          console.error('wrote overlap area as file ' + debugFilename)
          console.error('To read more about this error, please visit https://git.io/vx6nx')
          allZonesOk = false
        }
      }
      validationProgress.logNext()
    }
  }

  return allZonesOk ? null : 'Zone validation unsuccessful'
}

let oceanZoneBoundaries
let oceanZones = [
  { tzid: 'Etc/GMT-12', left: 172.5, right: 180 },
  { tzid: 'Etc/GMT-11', left: 157.5, right: 172.5 },
  { tzid: 'Etc/GMT-10', left: 142.5, right: 157.5 },
  { tzid: 'Etc/GMT-9', left: 127.5, right: 142.5 },
  { tzid: 'Etc/GMT-8', left: 112.5, right: 127.5 },
  { tzid: 'Etc/GMT-7', left: 97.5, right: 112.5 },
  { tzid: 'Etc/GMT-6', left: 82.5, right: 97.5 },
  { tzid: 'Etc/GMT-5', left: 67.5, right: 82.5 },
  { tzid: 'Etc/GMT-4', left: 52.5, right: 67.5 },
  { tzid: 'Etc/GMT-3', left: 37.5, right: 52.5 },
  { tzid: 'Etc/GMT-2', left: 22.5, right: 37.5 },
  { tzid: 'Etc/GMT-1', left: 7.5, right: 22.5 },
  { tzid: 'Etc/GMT', left: -7.5, right: 7.5 },
  { tzid: 'Etc/GMT+1', left: -22.5, right: -7.5 },
  { tzid: 'Etc/GMT+2', left: -37.5, right: -22.5 },
  { tzid: 'Etc/GMT+3', left: -52.5, right: -37.5 },
  { tzid: 'Etc/GMT+4', left: -67.5, right: -52.5 },
  { tzid: 'Etc/GMT+5', left: -82.5, right: -67.5 },
  { tzid: 'Etc/GMT+6', left: -97.5, right: -82.5 },
  { tzid: 'Etc/GMT+7', left: -112.5, right: -97.5 },
  { tzid: 'Etc/GMT+8', left: -127.5, right: -112.5 },
  { tzid: 'Etc/GMT+9', left: -142.5, right: -127.5 },
  { tzid: 'Etc/GMT+10', left: -157.5, right: -142.5 },
  { tzid: 'Etc/GMT+11', left: -172.5, right: -157.5 },
  { tzid: 'Etc/GMT+12', left: -180, right: -172.5 }
]

if (includedZones.length > 0) {
  oceanZones = oceanZones.filter(oceanZone => includedZones.indexOf(oceanZone) > -1)
}
if (excludedZones.length > 0) {
  oceanZones = oceanZones.filter(oceanZone => excludedZones.indexOf(oceanZone) === -1)
}

function addOceans (callback) {
  console.log('adding ocean boundaries')
  const zones = Object.keys(zoneCfg)

  const oceanProgress = new ProgressStats(
    'Oceans',
    oceanZones.length
  )

  oceanZoneBoundaries = oceanZones.map(zone => {
    oceanProgress.beginTask(zone.tzid, true)
    const geoJson = polygon([[
      [zone.left, 90],
      [zone.left, -90],
      [zone.right, -90],
      [zone.right, 90],
      [zone.left, 90]
    ]]).geometry

    let geom = geoJsonToGeom(geoJson)

    // diff against every zone
    zones.forEach(finalZone => {
      geom = debugGeo('diff', geom, finalZones[finalZone])
    })

    return {
      geom: postProcessZone(geom, true),
      tzid: zone.tzid
    }
  })

  callback()
}

function combineAndWriteZones (callback) {
  const regularWriter = new FeatureWriterStream(workingDir + '/combined.json')
  const oceanWriter = new FeatureWriterStream(workingDir + '/combined-with-oceans.json')
  const zones = Object.keys(zoneCfg)

  zones.forEach(zoneName => {
    const feature = {
      type: 'Feature',
      properties: { tzid: zoneName },
      geometry: geomToGeoJson(finalZones[zoneName])
    }
    const stringified = JSON.stringify(feature)
    regularWriter.add(stringified)
    oceanWriter.add(stringified)
  })
  oceanZoneBoundaries.forEach(boundary => {
    const feature = {
      type: 'Feature',
      properties: { tzid: boundary.tzid },
      geometry: boundary.geom
    }
    oceanWriter.add(JSON.stringify(feature))
  })
  asynclib.parallel([
    cb => regularWriter.end(cb),
    cb => oceanWriter.end(cb)
  ], callback)
}

function combineAndWriteOSMZones (callback) {
  const osmZoneWriter = new FeatureWriterStream(workingDir + '/combined-osm-zones.json')
  Object.keys(zoneCfg).forEach(tzId => {
    const tzBoundayName = `${tzId.replaceAll('/', '-')}-tz`
    const boundaryFilename = downloadsDir + '/' + tzBoundayName + '.json'
    const feature = {
      type: 'Feature',
      properties: { tzid: tzId },
      geometry: require(boundaryFilename)
    }
    const stringified = JSON.stringify(feature)
    osmZoneWriter.add(stringified)
  })
  osmZoneWriter.end(callback)
}

function downloadLastRelease (cb) {
  // download latest release info
  got(
    'https://api.github.com/repos/evansiroky/timezone-boundary-builder/releases/latest'
  ).json()
    .then(data => {
      // determine last release version name and download link
      const lastReleaseName = data.name
      lastReleaseJSONfile = `${workingDir}/${lastReleaseName}.json`
      let lastReleaseDownloadUrl
      for (let i = 0; i < data.assets.length; i++) {
        if (data.assets[i].browser_download_url.indexOf('timezones.geojson') > -1) {
          lastReleaseDownloadUrl = data.assets[i].browser_download_url
        }
      }
      if (!lastReleaseDownloadUrl) {
        return cb(new Error('geojson not found'))
      }

      // check for file that got downloaded
      fs.stat(lastReleaseJSONfile, function (err) {
        if (!err) {
          // file found, skip download steps
          return cb()
        }
        // file not found, download
        console.log(`Downloading latest release to ${lastReleaseJSONfile}.zip`)
        const pipeline = promisify(stream.pipeline)
        pipeline(
          got.stream(lastReleaseDownloadUrl),
          fs.createWriteStream(`${lastReleaseJSONfile}.zip`)
        ).then(() => {
          // unzip file
          console.log(`unzipping latest release from ${lastReleaseJSONfile}.zip`)
          exec(
            `unzip -o ${lastReleaseJSONfile} -d ${workingDir}`,
            err => {
              if (err) { return cb(err) }

              const srcFile = path.join(workingDir, 'combined.json')
              console.log(`unzipped file: ${srcFile}`)

              const destFile = lastReleaseJSONfile
              console.log(`Renaming ${srcFile} to ${destFile}`)
              fs.rename(srcFile, destFile, cb)
            }
          )
        })
      })
    })
}

function mergeZonesForCutoffYears (cb) {

}

function analyzeChangesFromLastRelease (cb) {
  // load last release data into memory
  console.log('loading previous release into memory')
  const lastReleaseData = require(lastReleaseJSONfile)

  // load each feature's geojson into JSTS format and then organized by tzid
  const lastReleaseZones = {}
  lastReleaseData.features.forEach(
    feature => {
      lastReleaseZones[feature.properties.tzid] = feature
    }
  )

  // generate set of keys from last release and current
  const zoneNames = new Set()
  Object.keys(finalZones).forEach(zoneName => zoneNames.add(zoneName))
  Object.keys(lastReleaseZones).forEach(zoneName => zoneNames.add(zoneName))

  // create diff for each zone
  const analysisProgress = new ProgressStats(
    'Analyzing diffs',
    zoneNames.size
  )
  const additionsWriter = new FeatureWriterStream(workingDir + '/additions.json')
  const removalsWriter = new FeatureWriterStream(workingDir + '/removals.json')
  zoneNames.forEach(zoneName => {
    analysisProgress.beginTask(zoneName, true)
    if (finalZones[zoneName] && lastReleaseZones[zoneName]) {
      // some zones take forever to diff unless they are buffered, so buffer by
      // just a small amount
      const lastReleaseGeom = geoJsonToGeom(
        lastReleaseZones[zoneName].geometry
      ).buffer(bufferDistance)
      const curDataGeom = finalZones[zoneName].buffer(bufferDistance)

      // don't diff equal geometries
      if (curDataGeom.equals(lastReleaseGeom)) return

      // diff current - last = additions
      const addition = debugGeo(
        'diff',
        curDataGeom,
        lastReleaseGeom,
        false,
        true
      )
      if (addition.getArea() > 0.0001) {
        additionsWriter.add(JSON.stringify({
          type: 'Feature',
          properties: { tzid: zoneName },
          geometry: geomToGeoJson(addition)
        }))
      }

      // diff last - current = removals
      const removal = debugGeo(
        'diff',
        lastReleaseGeom,
        curDataGeom,
        false,
        true
      )
      if (removal.getArea() > 0.0001) {
        removalsWriter.add(JSON.stringify({
          type: 'Feature',
          properties: { tzid: zoneName },
          geometry: geomToGeoJson(removal)
        }))
      }
    } else if (finalZones[zoneName]) {
      additionsWriter.add(JSON.stringify({
        type: 'Feature',
        properties: { tzid: zoneName },
        geometry: geomToGeoJson(finalZones[zoneName])
      }))
    } else {
      removalsWriter.add(JSON.stringify(lastReleaseZones[zoneName]))
    }
  })

  // write files
  asynclib.parallel([
    wcb => additionsWriter.end(wcb),
    wcb => removalsWriter.end(wcb)
  ], cb)
}

const autoScript = {
  makeDownloadsDir: function (cb) {
    overallProgress.beginTask(`Creating downloads dir (${downloadsDir})`)
    safeMkdir(downloadsDir, cb)
  },
  makeWorkingDir: function (cb) {
    overallProgress.beginTask(`Creating working dir (${workingDir})`)
    safeMkdir(workingDir, cb)
  },
  makeDistDir: function (cb) {
    overallProgress.beginTask(`Creating dist dir (${distDir})`)
    safeMkdir(distDir, cb)
  },
  getOsmBoundaries: ['makeDownloadsDir', function (results, cb) {
    overallProgress.beginTask('Downloading OSM boundaries')
    asynclib.eachSeries(Object.keys(osmBoundarySources), downloadOsmBoundary, cb)
  }],
  getOsmTzBoundaries: ['getOsmBoundaries', (results, cb) => {
    if (argv.skip_analyze_osm_tz_diffs) {
      overallProgress.beginTask('WARNING: Skipping download of all OSM timezone relations for analysis!')
      cb()
    } else {
      overallProgress.beginTask('Downloading OSM TZ boundaries')
      asynclib.eachSeries(Object.keys(zoneCfg), downloadOsmTimezoneBoundary, cb)
    }
  }],
  downloadLastRelease: ['makeWorkingDir', function (results, cb) {
    if (argv.skip_analyze_diffs) {
      overallProgress.beginTask('WARNING: Skipping download of last release for analysis!')
      cb()
    } else {
      overallProgress.beginTask('Downloading last release for analysis')
      downloadLastRelease(cb)
    }
  }],
  createZones: ['makeWorkingDir', 'getOsmBoundaries', function (results, cb) {
    overallProgress.beginTask('Creating timezone boundaries')
    asynclib.each(Object.keys(zoneCfg), makeTimezoneBoundary, cb)
  }],
  validateZones: ['createZones', function (results, cb) {
    overallProgress.beginTask('Validating timezone boundaries')
    loadFinalZonesIntoMemory()
    if (argv.skip_validation) {
      console.warn('WARNING: Skipping validation!')
      cb()
    } else {
      cb(validateTimezoneBoundaries())
    }
  }],
  addOceans: ['validateZones', function (results, cb) {
    overallProgress.beginTask('Adding oceans')
    addOceans(cb)
  }],
  mergeZones: ['addOceans', function (results, cb) {
    overallProgress.beginTask('Merging zones')
    combineAndWriteZones(cb)
  }],
  mergeOSMZones: ['getOsmTzBoundaries', function (results, cb) {
    if (argv.skip_analyze_osm_tz_diffs) {
      overallProgress.beginTask('WARNING: Skipping merging of all OSM timezone relations for analysis!')
      cb()
    } else {
      overallProgress.beginTask('Merging osm zones')
      combineAndWriteOSMZones(cb)
    }
  }],
  zipGeoJson: ['mergeZones', function (results, cb) {
    if (argv.skip_zip) {
      overallProgress.beginTask('Skipping zip')
      return cb()
    }
    overallProgress.beginTask('Zipping geojson')
    const zipFile = distDir + '/timezones.geojson.zip'
    const jsonFile = workingDir + '/combined.json'
    exec('zip -j ' + zipFile + ' ' + jsonFile, cb)
  }],
  zipGeoJsonWithOceans: ['mergeZones', function (results, cb) {
    if (argv.skip_zip) {
      overallProgress.beginTask('Skipping with oceans zip')
      return cb()
    }
    overallProgress.beginTask('Zipping geojson with oceans')
    const zipFile = distDir + '/timezones-with-oceans.geojson.zip'
    const jsonFile = workingDir + '/combined-with-oceans.json'
    exec('zip -j ' + zipFile + ' ' + jsonFile, cb)
  }],
  makeShapefile: ['mergeZones', function (results, cb) {
    if (argv.skip_shapefile) {
      overallProgress.beginTask('Skipping shapefile creation')
      return cb()
    }
    overallProgress.beginTask('Converting from geojson to shapefile')
    const shapeFileGlob = workingDir + '/combined-shapefile.*'
    rimraf.sync(shapeFileGlob)
    const shapeFile = workingDir + '/combined-shapefile.shp'
    const jsonFile = workingDir + '/combined.json'
    exec(
      'ogr2ogr -f "ESRI Shapefile" ' + shapeFile + ' ' + jsonFile,
      function (err, stdout, stderr) {
        if (err) { return cb(err) }
        const shapeFileZip = distDir + '/timezones.shapefile.zip'
        exec('zip -j ' + shapeFileZip + ' ' + shapeFileGlob, cb)
      }
    )
  }],
  makeOSMTimezoneShapefile: ['mergeOSMZones', function (results, cb) {
    if (argv.skip_analyze_osm_tz_diffs || argv.skip_shapefile) {
      overallProgress.beginTask('Skipping OSM zone shapefile creation')
      return cb()
    }
    overallProgress.beginTask('Converting from geojson to shapefile')
    const shapeFileGlob = workingDir + '/combined-osm-zone-shapefile.*'
    rimraf.sync(shapeFileGlob)
    const shapeFile = workingDir + '/combined-osm-zone-shapefile.shp'
    const jsonFile = workingDir + '/combined-osm-zones.json'
    exec(
      'ogr2ogr -f "ESRI Shapefile" ' + shapeFile + ' ' + jsonFile,
      cb
    )
  }],
  makeShapefileWithOceans: ['mergeZones', function (results, cb) {
    if (argv.skip_shapefile) {
      overallProgress.beginTask('Skipping with oceans shapefile creation')
      return cb()
    }
    overallProgress.beginTask('Converting from geojson with oceans to shapefile')
    const shapeFileGlob = workingDir + '/combined-shapefile-with-oceans.*'
    rimraf.sync(shapeFileGlob)
    const shapeFile = workingDir + '/combined-shapefile-with-oceans.shp'
    const jsonFile = workingDir + '/combined-with-oceans.json'
    exec(
      'ogr2ogr -f "ESRI Shapefile" ' + shapeFile + ' ' + jsonFile,
      function (err, stdout, stderr) {
        if (err) { return cb(err) }
        const shapeFileZip = distDir + '/timezones-with-oceans.shapefile.zip'
        exec('zip -j ' + shapeFileZip + ' ' + shapeFileGlob, cb)
      }
    )
  }],
  makeListOfTimeZoneNames: function (cb) {
    overallProgress.beginTask('Writing timezone names to file')
    let zoneNames = Object.keys(zoneCfg)
    oceanZones.forEach(oceanZone => {
      zoneNames.push(oceanZone.tzid)
    })
    if (includedZones.length > 0) {
      zoneNames = zoneNames.filter(zoneName => includedZones.indexOf(zoneName) > -1)
    }
    if (excludedZones.length > 0) {
      zoneNames = zoneNames.filter(zoneName => excludedZones.indexOf(zoneName) === -1)
    }
    fs.writeFile(
      distDir + '/timezone-names.json',
      JSON.stringify(zoneNames),
      cb
    )
  },
  mergeZonesForCutoffYears: ['validateZones', function (results, cb) {
    mergeZonesForCutoffYears(cb)
  }],
  analyzeChangesFromLastRelease: ['downloadLastRelease', 'mergeZones', function (results, cb) {
    if (argv.skip_analyze_diffs) {
      overallProgress.beginTask('WARNING: Skipping analysis of changes from last release!')
      cb()
    } else {
      overallProgress.beginTask('Analyzing changes from last release')
      analyzeChangesFromLastRelease(cb)
    }
  }],
  cleanDownloadFolder: ['makeDistDir', 'getOsmBoundaries', 'makeOSMTimezoneShapefile', function (results, cb) {
    overallProgress.beginTask('cleanDownloadFolder')
    const downloadedFilenames = Object.keys(osmBoundarySources).map(name => `${name}.json`)
    fs.readdir(downloadsDir, (err, files) => {
      if (err) return cb(err)
      asynclib.each(
        files,
        (file, fileCb) => {
          if (downloadedFilenames.indexOf(file) === -1) {
            return fs.unlink(path.join(downloadsDir, file), fileCb)
          }
          fileCb()
        },
        cb
      )
    })
  }],
  zipInputData: ['cleanDownloadFolder', function (results, cb) {
    overallProgress.beginTask('Zipping up input data')
    exec('zip -j ' + distDir + '/input-data.zip ' + downloadsDir +
         '/* timezones.json osmBoundarySources.json expectedZoneOverlaps.json', cb)
  }]
}

const overallProgress = new ProgressStats('Overall', Object.keys(autoScript).length)

asynclib.auto(autoScript, function (err, results) {
  console.log('done')
  if (err) {
    console.log('error!', err)
  }
})
