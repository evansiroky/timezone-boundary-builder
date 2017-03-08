var exec = require('child_process').exec
var fs = require('fs')

var helpers = require('@turf/helpers')
var multiPolygon = helpers.multiPolygon
var polygon = helpers.polygon
var asynclib = require('async')
var jsts = require('jsts')
var rimraf = require('rimraf')
var overpass = require('query-overpass')

var osmBoundarySources = require('./osmBoundarySources.json')
var zoneCfg = require('./timezones.json')
var geoJsonReader = new jsts.io.GeoJSONReader()
var geoJsonWriter = new jsts.io.GeoJSONWriter()
var distZones = {}
var minRequestGap = 4
var curRequestGap = 4

var safeMkdir = function (dirname, callback) {
  fs.mkdir(dirname, function (err) {
    if (err && err.code === 'EEXIST') {
      callback()
    } else {
      callback(err)
    }
  })
}

var debugGeo = function (op, a, b) {
  var result

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
        try {
          result = a.difference(b)
        } catch (e) {
          if (e.name === 'TopologyException') {
            console.log('retry with GeometryPrecisionReducer')
            var precisionModel = new jsts.geom.PrecisionModel(10000)
            var precisionReducer = new jsts.precision.GeometryPrecisionReducer(precisionModel)

            a = precisionReducer.reduce(a)
            b = precisionReducer.reduce(b)

            result = a.difference(b)
          } else {
            throw e
          }
        }
        break
      default:
        var err = new Error('invalid op: ' + op)
        throw err
    }
  } catch (e) {
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

var downloadOsmBoundary = function (boundaryId, boundaryCallback) {
  var cfg = osmBoundarySources[boundaryId]
  var query = '[out:json][timeout:60];(relation'
  var boundaryFilename = './downloads/' + boundaryId + '.json'
  var debug = 'getting data for ' + boundaryId
  var queryKeys = Object.keys(cfg)

  for (var i = queryKeys.length - 1; i >= 0; i--) {
    var k = queryKeys[i]
    var v = cfg[k]

    query += '["' + k + '"="' + v + '"]'
  }

  query += ');out body;>;out meta qt;'

  console.log(debug)

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
      if (!data.features || data.features.length === 0) {
        var err = new Error('Invalid geojson for boundary: ' + boundaryId)
        return cb(err)
      }
      cb()
    }],
    saveSingleMultiPolygon: ['validateOverpassResult', function (results, cb) {
      var data = results.downloadFromOverpass
      var combined

      // union all multi-polygons / polygons into one
      for (var i = data.features.length - 1; i >= 0; i--) {
        var curOsmGeom = data.features[i].geometry
        if (curOsmGeom.type === 'Polygon' || curOsmGeom.type === 'MultiPolygon') {
          console.log('combining border')
          try {
            var curGeom = geoJsonToGeom(curOsmGeom)
          } catch (e) {
            console.error('error converting overpass result to geojson')
            fs.writeFileSync(boundaryId + '_fixed.json', JSON.stringify(data))
            throw e
          }
          if (!combined) {
            combined = curGeom
          } else {
            combined = debugGeo('union', curGeom, combined)
          }
        }
      }
      fs.writeFile(boundaryFilename, geomToGeoJsonString(combined), cb)
    }]
  }, boundaryCallback)
}

var getTzDistFilename = function (tzid) {
  return './dist/' + tzid.replace(/\//g, '__') + '.json'
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
    geoJson = require('./downloads/' + source.id + '.json')
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

var makeTimezoneBoundary = function (tzid, callback) {
  console.log('makeTimezoneBoundary for', tzid)

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
      geomToGeoJsonString(geom),
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

var validateTimezoneBoundaries = function () {
  console.log('do validation')
  var allZonesOk = true
  var zones = Object.keys(zoneCfg)
  var compareTzid, tzid, zoneGeom

  for (var i = 0; i < zones.length; i++) {
    tzid = zones[i]
    zoneGeom = getDistZoneGeom(tzid)

    for (var j = i + 1; j < zones.length; j++) {
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
          console.log('Validation error: ' + tzid + ' intersects ' + compareTzid + ' area: ' + intersectedArea)
          allZonesOk = false
        }
      }
    }
  }

  return allZonesOk ? null : 'Zone validation unsuccessful'
}

var combineAndWriteZones = function (callback) {
  var stream = fs.createWriteStream('./dist/combined.json')
  var zones = Object.keys(zoneCfg)

  stream.write('{"type":"FeatureCollection","features":[')

  for (var i = 0; i < zones.length; i++) {
    if (i > 0) {
      stream.write(',')
    }
    var feature = {
      type: 'Feature',
      properties: { tzid: zones[i] },
      geometry: geomToGeoJson(getDistZoneGeom(zones[i]))
    }
    stream.write(JSON.stringify(feature))
  }
  stream.end(']}', callback)
}

asynclib.auto({
  makeDownloadsDir: function (cb) {
    console.log('creating downloads dir')
    safeMkdir('./downloads', cb)
  },
  makeDistDir: function (cb) {
    console.log('createing dist dir')
    safeMkdir('./dist', cb)
  },
  getOsmBoundaries: ['makeDownloadsDir', function (results, cb) {
    console.log('downloading osm boundaries')
    asynclib.eachSeries(Object.keys(osmBoundarySources), downloadOsmBoundary, cb)
  }],
  createZones: ['makeDistDir', 'getOsmBoundaries', function (results, cb) {
    console.log('createZones')
    asynclib.each(Object.keys(zoneCfg), makeTimezoneBoundary, cb)
  }],
  validateZones: ['createZones', function (results, cb) {
    console.log('validating zones')
    loadDistZonesIntoMemory()
    cb(validateTimezoneBoundaries())
  }],
  mergeZones: ['validateZones', function (results, cb) {
    console.log('merge zones')
    combineAndWriteZones(cb)
  }],
  zipGeoJson: ['mergeZones', function (results, cb) {
    console.log('zip geojson')
    exec('zip dist/timezones.geojson.zip dist/combined.json', cb)
  }],
  makeShapefile: ['mergeZones', function (results, cb) {
    console.log('convert from geojson to shapefile')
    rimraf.sync('dist/dist')
    rimraf.sync('dist/combined_shapefile.*')
    exec('ogr2ogr -nlt MULTIPOLYGON dist/combined_shapefile.shp dist/combined.json OGRGeoJSON', function (err, stdout, stderr) {
      if (err) { return cb(err) }
      exec('zip dist/timezones.shapefile.zip dist/combined_shapefile.*', cb)
    })
  }]
}, function (err, results) {
  console.log('done')
  if (err) {
    console.log('error!', err)
    return
  }
})
