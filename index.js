var exec = require('child_process').exec
var fs = require('fs')
var path = require('path')

var area = require('@mapbox/geojson-area')
var geojsonhint = require('@mapbox/geojsonhint')
var bbox = require('@turf/bbox').default
var helpers = require('@turf/helpers')
var multiPolygon = helpers.multiPolygon
var polygon = helpers.polygon
var asynclib = require('async')
var https = require('follow-redirects').https
var jsts = require('jsts')
var rimraf = require('rimraf')
var overpass = require('query-overpass')
var yargs = require('yargs')

const FeatureWriterStream = require('./util/featureWriterStream')
const ProgressStats = require('./util/progressStats')

var osmBoundarySources = require('./osmBoundarySources.json')
var zoneCfg = require('./timezones.json')
var expectedZoneOverlaps = require('./expectedZoneOverlaps.json')

const argv = yargs
  .option('downloads_dir', {
    description: 'Set the download location',
    default: './downloads',
    type: 'string'
  })
  .option('dist_dir', {
    description: 'Set the dist location',
    default: './dist',
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
  .help()
  .strict()
  .alias('help', 'h')
  .argv

// Resolve the arguments with paths so relative paths become absolute.
const downloadsDir = path.resolve(argv.downloads_dir)
const distDir = path.resolve(argv.dist_dir)

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
  var newOsmBoundarySources = {}
  Object.keys(zoneCfg).forEach((zoneName) => {
    zoneCfg[zoneName].forEach((op) => {
      if (op.source === 'overpass') {
        newOsmBoundarySources[op.id] = osmBoundarySources[op.id]
      }
    })
  })

  osmBoundarySources = newOsmBoundarySources
}

var geoJsonReader = new jsts.io.GeoJSONReader()
var geoJsonWriter = new jsts.io.GeoJSONWriter()
var precisionModel = new jsts.geom.PrecisionModel(1000000)
var precisionReducer = new jsts.precision.GeometryPrecisionReducer(precisionModel)
var distZones = {}
var lastReleaseJSONfile
var minRequestGap = 4
var curRequestGap = 4
const bufferDistance = 0.01

var safeMkdir = function (dirname, callback) {
  fs.mkdir(dirname, function (err) {
    if (err && err.code === 'EEXIST') {
      callback()
    } else {
      callback(err)
    }
  })
}

var debugGeo = function (
  op,
  a,
  b,
  reducePrecision,
  bufferAfterPrecisionReduction
) {
  var result

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
        var err = new Error('invalid op: ' + op)
        throw err
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

var fetchIfNeeded = function (file, superCallback, downloadCallback, fetchFn) {
  // check for file that got downloaded
  fs.stat(file, function (err) {
    if (!err) {
      // file found, skip download steps
      return superCallback()
    }
    // check for manual file that got fixed and needs validation
    var fixedFile = file.replace('.json', '_fixed.json')
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

var geoJsonToGeom = function (geoJson) {
  try {
    return geoJsonReader.read(JSON.stringify(geoJson))
  } catch (e) {
    console.error('error converting geojson to geometry')
    fs.writeFileSync('debug_geojson_read_error.json', JSON.stringify(geoJson))
    throw e
  }
}

var geomToGeoJson = function (geom) {
  return geoJsonWriter.write(geom)
}

var geomToGeoJsonString = function (geom) {
  return JSON.stringify(geoJsonWriter.write(geom))
}

const downloadProgress = new ProgressStats(
  'Downloading',
  Object.keys(osmBoundarySources).length
)

var downloadOsmBoundary = function (boundaryId, boundaryCallback) {
  var cfg = osmBoundarySources[boundaryId]
  var query = '[out:json][timeout:60];('
  if (cfg.way) {
    query += 'way'
  } else {
    query += 'relation'
  }
  var boundaryFilename = downloadsDir + '/' + boundaryId + '.json'
  var debug = 'getting data for ' + boundaryId
  var queryKeys = Object.keys(cfg)

  for (var i = queryKeys.length - 1; i >= 0; i--) {
    var k = queryKeys[i]
    if (k === 'way') continue
    var v = cfg[k]

    query += '["' + k + '"="' + v + '"]'
  }

  query += ';);out body;>;out meta qt;'

  downloadProgress.beginTask(debug, true)

  asynclib.auto({
    downloadFromOverpass: function (cb) {
      console.log('downloading from overpass')
      fetchIfNeeded(boundaryFilename, boundaryCallback, cb, function () {
        var overpassResponseHandler = function (err, data) {
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
        var makeQuery = function () {
          console.log('waiting ' + curRequestGap + ' seconds')
          setTimeout(function () {
            overpass(query, overpassResponseHandler, { flatProperties: true })
          }, curRequestGap * 1000)
        }
        makeQuery()
      })
    },
    validateOverpassResult: ['downloadFromOverpass', function (results, cb) {
      var data = results.downloadFromOverpass
      if (!data.features) {
        var err = new Error('Invalid geojson for boundary: ' + boundaryId)
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
      var data = results.downloadFromOverpass
      var combined

      // union all multi-polygons / polygons into one
      for (var i = data.features.length - 1; i >= 0; i--) {
        var curOsmGeom = data.features[i].geometry
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
            const problemFilename = boundaryId + '_convert_to_geom_error.json'
            fs.writeFileSync(problemFilename, stringifiedGeojson)
            console.error('saved problem file to ' + problemFilename)
            console.error('To read more about this error, please visit https://git.io/vxKQq')
            return cb(errors)
          }
          try {
            var curGeom = geoJsonToGeom(curOsmGeom)
          } catch (e) {
            console.error('error converting overpass result to geojson')
            console.error(e)

            fs.writeFileSync(boundaryId + '_convert_to_geom_error-all-features.json', JSON.stringify(data))
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
        fs.writeFile(boundaryFilename, geomToGeoJsonString(combined), cb)
      } catch (e) {
        console.error('error writing combined border to geojson')
        fs.writeFileSync(boundaryId + '_combined_border_convert_to_geom_error.json', JSON.stringify(data))
        return cb(e)
      }
    }]
  }, boundaryCallback)
}

var getTzDistFilename = function (tzid) {
  return distDir + '/' + tzid.replace(/\//g, '__') + '.json'
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
var getDataSource = function (source) {
  var geoJson
  if (source.source === 'overpass') {
    geoJson = require(downloadsDir + '/' + source.id + '.json')
  } else if (source.source === 'manual-polygon') {
    geoJson = polygon(source.data).geometry
  } else if (source.source === 'manual-multipolygon') {
    geoJson = multiPolygon(source.data).geometry
  } else if (source.source === 'dist') {
    geoJson = require(getTzDistFilename(source.id))
  } else {
    var err = new Error('unknown source: ' + source.source)
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
var postProcessZone = function (geom, returnAsObject) {
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

var makeTimezoneBoundary = function (tzid, callback) {
  buildingProgress.beginTask(`makeTimezoneBoundary for ${tzid}`, true)

  var ops = zoneCfg[tzid]
  var geom

  asynclib.eachSeries(ops, function (task, cb) {
    var taskData = getDataSource(task)
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
      var err = new Error('unknown op: ' + task.op)
      return cb(err)
    }
    cb()
  },
  function (err) {
    if (err) { return callback(err) }
    fs.writeFile(getTzDistFilename(tzid),
      postProcessZone(geom),
      callback)
  })
}

var loadDistZonesIntoMemory = function () {
  console.log('load zones into memory')
  var zones = Object.keys(zoneCfg)
  var tzid

  for (var i = 0; i < zones.length; i++) {
    tzid = zones[i]
    distZones[tzid] = getDataSource({ source: 'dist', id: tzid })
  }
}

var getDistZoneGeom = function (tzid) {
  return distZones[tzid]
}

var roundDownToTenth = function (n) {
  return Math.floor(n * 10) / 10
}

var roundUpToTenth = function (n) {
  return Math.ceil(n * 10) / 10
}

var formatBounds = function (bounds) {
  let boundsStr = '['
  boundsStr += roundDownToTenth(bounds[0]) + ', '
  boundsStr += roundDownToTenth(bounds[1]) + ', '
  boundsStr += roundUpToTenth(bounds[2]) + ', '
  boundsStr += roundUpToTenth(bounds[3]) + ']'
  return boundsStr
}

var validateTimezoneBoundaries = function () {
  const numZones = Object.keys(zoneCfg).length
  const validationProgress = new ProgressStats(
    'Validation',
    numZones * (numZones + 1) / 2
  )

  console.log('do validation... this may take a few minutes')
  var allZonesOk = true
  var zones = Object.keys(zoneCfg)
  var lastPct = 0
  var compareTzid, tzid, zoneGeom

  for (var i = 0; i < zones.length; i++) {
    tzid = zones[i]
    zoneGeom = getDistZoneGeom(tzid)

    for (var j = i + 1; j < zones.length; j++) {
      const curPct = Math.floor(validationProgress.getPercentage())
      if (curPct % 10 === 0 && curPct !== lastPct) {
        validationProgress.printStats('Validating zones', true)
        lastPct = curPct
      }
      compareTzid = zones[j]

      var compareZoneGeom = getDistZoneGeom(compareTzid)

      var intersects = false
      try {
        intersects = debugGeo('intersects', zoneGeom, compareZoneGeom)
      } catch (e) {
        console.warn('warning, encountered intersection error with zone ' + tzid + ' and ' + compareTzid)
      }
      if (intersects) {
        var intersectedGeom = debugGeo('intersection', zoneGeom, compareZoneGeom)
        var intersectedArea = intersectedGeom.getArea()

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

var addOceans = function (callback) {
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
    zones.forEach(distZone => {
      geom = debugGeo('diff', geom, getDistZoneGeom(distZone))
    })

    return {
      geom: postProcessZone(geom, true),
      tzid: zone.tzid
    }
  })

  callback()
}

var combineAndWriteZones = function (callback) {
  const regularWriter = new FeatureWriterStream(distDir + '/combined.json')
  const oceanWriter = new FeatureWriterStream(distDir + '/combined-with-oceans.json')
  var zones = Object.keys(zoneCfg)

  zones.forEach(zoneName => {
    const feature = {
      type: 'Feature',
      properties: { tzid: zoneName },
      geometry: geomToGeoJson(getDistZoneGeom(zoneName))
    }
    const stringified = JSON.stringify(feature)
    regularWriter.add(stringified)
    oceanWriter.add(stringified)
  })
  oceanZoneBoundaries.forEach(boundary => {
    var feature = {
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

var downloadLastRelease = function (cb) {
  // download latest release info
  https.get(
    {
      headers: { 'user-agent': 'timezone-boundary-builder' },
      host: 'api.github.com',
      path: '/repos/evansiroky/timezone-boundary-builder/releases/latest'
    },
    function (res) {
      var data = ''
      res.on('data', function (chunk) {
        data += chunk
      })
      res.on('end', function () {
        data = JSON.parse(data)
        // determine last release version name and download link
        const lastReleaseName = data.name
        lastReleaseJSONfile = `./dist/${lastReleaseName}.json`
        let lastReleaseDownloadUrl
        for (var i = 0; i < data.assets.length; i++) {
          if (data.assets[i].browser_download_url.indexOf('timezones-with-oceans.geojson') > -1) {
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
          https.get({
            headers: { 'user-agent': 'timezone-boundary-builder' },
            host: 'github.com',
            path: lastReleaseDownloadUrl.replace('https://github.com', '')
          }, function (response) {
            var file = fs.createWriteStream(`${lastReleaseJSONfile}.zip`)
            response.pipe(file)
            file.on('finish', function () {
              file.close((err) => {
                if (err) return cb(err)
                // unzip file
                console.log('unzipping latest release')
                exec(
                  `unzip -o ${lastReleaseJSONfile} -d dist`,
                  err => {
                    if (err) { return cb(err) }
                    console.log('unzipped file')
                    console.log('moving unzipped file')
                    // might need to change this after changes to how files are
                    // zipped after 2020a
                    fs.copyFile(
                      path.join(
                        'dist',
                        'dist',
                        'combined-with-oceans.json'
                      ),
                      lastReleaseJSONfile,
                      cb
                    )
                  }
                )
              })
            })
          }).on('error', cb)
        })
      })
    }
  )
}

var analyzeChangesFromLastRelease = function (cb) {
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
  Object.keys(distZones).forEach(zoneName => zoneNames.add(zoneName))
  Object.keys(lastReleaseZones).forEach(zoneName => zoneNames.add(zoneName))

  // create diff for each zone
  const analysisProgress = new ProgressStats(
    'Analyzing diffs',
    zoneNames.size
  )
  const additionsWriter = new FeatureWriterStream(distDir + '/additions.json')
  const removalsWriter = new FeatureWriterStream(distDir + '/removals.json')
  zoneNames.forEach(zoneName => {
    analysisProgress.beginTask(zoneName, true)
    if (distZones[zoneName] && lastReleaseZones[zoneName]) {
      // some zones take forever to diff unless they are buffered, so buffer by
      // just a small amount
      const lastReleaseGeom = geoJsonToGeom(
        lastReleaseZones[zoneName].geometry
      ).buffer(bufferDistance)
      const curDataGeom = getDistZoneGeom(zoneName).buffer(bufferDistance)

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
    } else if (distZones[zoneName]) {
      additionsWriter.add(JSON.stringify({
        type: 'Feature',
        properties: { tzid: zoneName },
        geometry: geomToGeoJson(getDistZoneGeom(zoneName))
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
    overallProgress.beginTask('Creating downloads dir')
    safeMkdir(downloadsDir, cb)
  },
  makeDistDir: function (cb) {
    overallProgress.beginTask('Creating dist dir')
    safeMkdir(distDir, cb)
  },
  getOsmBoundaries: ['makeDownloadsDir', function (results, cb) {
    overallProgress.beginTask('Downloading osm boundaries')
    asynclib.eachSeries(Object.keys(osmBoundarySources), downloadOsmBoundary, cb)
  }],
  cleanDownloadFolder: ['makeDistDir', 'getOsmBoundaries', function (results, cb) {
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
  }],
  downloadLastRelease: ['makeDistDir', function (results, cb) {
    if (argv.skip_analyze_diffs) {
      overallProgress.beginTask('WARNING: Skipping download of last release for analysis!')
      cb()
    } else {
      overallProgress.beginTask('Downloading last release for analysis')
      downloadLastRelease(cb)
    }
  }],
  createZones: ['makeDistDir', 'getOsmBoundaries', function (results, cb) {
    overallProgress.beginTask('Creating timezone boundaries')
    asynclib.each(Object.keys(zoneCfg), makeTimezoneBoundary, cb)
  }],
  validateZones: ['createZones', function (results, cb) {
    overallProgress.beginTask('Validating timezone boundaries')
    loadDistZonesIntoMemory()
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
  zipGeoJson: ['mergeZones', function (results, cb) {
    if (argv.skip_zip) {
      overallProgress.beginTask('Skipping zip')
      return cb()
    }
    overallProgress.beginTask('Zipping geojson')
    const zipFile = distDir + '/timezones.geojson.zip'
    const jsonFile = distDir + '/combined.json'
    exec('zip -j ' + zipFile + ' ' + jsonFile, cb)
  }],
  zipGeoJsonWithOceans: ['mergeZones', function (results, cb) {
    if (argv.skip_zip) {
      overallProgress.beginTask('Skipping with oceans zip')
      return cb()
    }
    overallProgress.beginTask('Zipping geojson with oceans')
    const zipFile = distDir + '/timezones-with-oceans.geojson.zip'
    const jsonFile = distDir + '/combined-with-oceans.json'
    exec('zip -j ' + zipFile + ' ' + jsonFile, cb)
  }],
  makeShapefile: ['mergeZones', function (results, cb) {
    if (argv.skip_shapefile) {
      overallProgress.beginTask('Skipping shapefile creation')
      return cb()
    }
    overallProgress.beginTask('Converting from geojson to shapefile')
    const shapeFileGlob = distDir + '/combined-shapefile.*'
    rimraf.sync(shapeFileGlob)
    const shapeFile = distDir + '/combined-shapefile.shp'
    const jsonFile = distDir + '/combined.json'
    exec(
      'ogr2ogr -f "ESRI Shapefile" ' + shapeFile + ' ' + jsonFile,
      function (err, stdout, stderr) {
        if (err) { return cb(err) }
        const shapeFileZip = distDir + '/timezones.shapefile.zip'
        exec('zip -j ' + shapeFileZip + ' ' + shapeFileGlob, cb)
      }
    )
  }],
  makeShapefileWithOceans: ['mergeZones', function (results, cb) {
    if (argv.skip_shapefile) {
      overallProgress.beginTask('Skipping with oceans shapefile creation')
      return cb()
    }
    overallProgress.beginTask('Converting from geojson with oceans to shapefile')
    const shapeFileGlob = distDir + '/combined-shapefile-with-oceans.*'
    rimraf.sync(shapeFileGlob)
    const shapeFile = distDir + '/combined-shapefile-with-oceans.shp'
    const jsonFile = distDir + '/combined-with-oceans.json'
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
  analyzeChangesFromLastRelease: ['downloadLastRelease', 'mergeZones', function (results, cb) {
    if (argv.skip_analyze_diffs) {
      overallProgress.beginTask('WARNING: Skipping analysis of changes from last release!')
      cb()
    } else {
      overallProgress.beginTask('Analyzing changes from last release')
      analyzeChangesFromLastRelease(cb)
    }
  }]
}

const overallProgress = new ProgressStats('Overall', Object.keys(autoScript).length)

asynclib.auto(autoScript, function (err, results) {
  console.log('done')
  if (err) {
    console.log('error!', err)
  }
})
