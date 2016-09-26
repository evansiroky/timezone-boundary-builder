var fs = require('fs'),
  http = require('http')

var async = require('async'),
  jsts = require('jsts'),
  multiPolygon = require('turf-multipolygon'),
  overpass = require('query-overpass'),
  polygon = require('turf-polygon'),
  shp = require('shpjs')


var osmBoundarySources = require('./osmBoundarySources.json'),
  zoneCfg = require('./timezones.json'),
  geoJsonReader = new jsts.io.GeoJSONReader(),
  geoJsonWriter = new jsts.io.GeoJSONWriter(),
  distZones = {}

var safeMkdir = function(dirname, callback) {
  fs.mkdir(dirname, function(err) {
    if(err && err.code === 'EEXIST') {
      callback()
    } else {
      callback(err)
    }
  })
}

debugGeo = function(op, a, b) {

  var result

  try {
    switch(op) {
      case 'union':
        result = a.union(b)
        break
      case 'intersection':
        result = a.intersection(b)
        break
      case 'diff':
        try {
          result = a.difference(b)
        } catch(e) {
          if(e.name === 'TopologyException') {
            console.log('retry with GeometryPrecisionReducer')
            var precisionModel = new jsts.geom.PrecisionModel(10000),
              precisionReducer = new jsts.precision.GeometryPrecisionReducer(precisionModel)

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
  } catch(e) {
    console.log('op err')
    console.log(e)
    console.log(e.stack)
    fs.writeFileSync('debug_' + op + '_a.json', JSON.stringify(geoJsonWriter.write(a)))
    fs.writeFileSync('debug_' + op + '_b.json', JSON.stringify(geoJsonWriter.write(b)))
    throw e
  }

  return result
}

var fetchIfNeeded = function(file, superCallback, fetchFn) {
  fs.stat(file, function(err) {
    if(!err) { return superCallback() }
    fetchFn()
  })
}

var geoJsonToGeom = function(geoJson) {
  return geoJsonReader.read(JSON.stringify(geoJson))
}

var geomToGeoJsonString = function(geom) {
  return JSON.stringify(geoJsonWriter.write(geom))
}

var downloadOsmBoundary = function(boundaryId, boundaryCallback) {
  var cfg = osmBoundarySources[boundaryId],
    query = '[out:json][timeout:60];(relation',
    boundaryFilename = './downloads/' + boundaryId + '.json',
    debug = 'getting data for ' + boundaryId,
    queryKeys = Object.keys(cfg)

  for (var i = queryKeys.length - 1; i >= 0; i--) {
    var k = queryKeys[i],
      v = cfg[k]

    query += '["' + k + '"="' + v + '"]'

  }

  query += ');out body;>;out meta qt;'

  console.log(debug)

  async.auto({
    downloadFromOverpass: function(cb) {
      console.log('downloading from overpass')
      fetchIfNeeded(boundaryFilename, boundaryCallback, function() {
        overpass(query, cb, { flatProperties: true })
      })
    },
    validateOverpassResult: ['downloadFromOverpass', function(results, cb) {
      var data = results.downloadFromOverpass
      if(!data.features || data.features.length == 0) {
        err = new Error('Invalid geojson for boundary: ' + boundaryId)
        return cb(err)
      }
      cb()
    }],
    saveSingleMultiPolygon: ['validateOverpassResult', function(results, cb) {
      var data = results.downloadFromOverpass,
        combined

      // union all multi-polygons / polygons into one
      for (var i = data.features.length - 1; i >= 0; i--) {
        var curOsmGeom = data.features[i].geometry
        if(curOsmGeom.type === 'Polygon' || curOsmGeom.type === 'MultiPolygon') {
          console.log('combining border')
          var curGeom = geoJsonToGeom(curOsmGeom)
          if(!combined) {
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
var getDataSource = function(source) {
  var geoJson
  if(source.source === 'overpass') {
    geoJson = require('./downloads/' + source.id + '.json')
  } else if(source.source === 'manual-polygon') {
    geoJson = polygon(source.data).geometry
  } else if(source.source === 'manual-multipolygon') {
    geoJson = multiPolygon(source.data).geometry
  } else if(source.source === 'dist') {
    geoJson = require(getTzDistFilename(source.id))
  } else {
    var err = new Error('unknown source: ' + source.source)
    throw err
  }
  return geoJsonToGeom(geoJson)
}

var makeTimezoneBoundary = function(tzid, callback) {
  console.log('makeTimezoneBoundary for', tzid)

  var ops = zoneCfg[tzid],
    geom

  async.eachSeries(ops, function(task, cb) {
    var taskData = getDataSource(task)
    console.log('-', task.op, task.id)
    if(task.op === 'init') {
      geom = taskData
    } else if(task.op === 'intersect') {
      geom = debugGeo('intersection', geom, taskData)
    } else if(task.op === 'difference') {
      geom = debugGeo('diff', geom, taskData)
    } else if(task.op === 'difference-reverse-order') {
      geom = debugGeo('diff', taskData, geom)
    } else if(task.op === 'union') {
      geom = debugGeo('union', geom, taskData)
    } else {
      var err = new Error('unknown op: ' + task.op)
      return cb(err)
    }
    cb()
  },
  function(err) {
    if(err) { return callback(err) }
    fs.writeFile(getTzDistFilename(tzid),
      geomToGeoJsonString(geom),
      callback)
  })
}

var loadDistZonesIntoMemory = function () {
  console.log('load zones into memory')
  var zones = Object.keys(zoneCfg),
    tzid

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
  var allZonesOk = true,
    zones = Object.keys(zoneCfg),
    compareTzid, tzid, zoneGeom

  for (var i = 0; i < zones.length; i++) {
    tzid = zones[i]
    zoneGeom = getDistZoneGeom(tzid)

    for (var j = i + 1; j < zones.length; j++) {
      compareTzid = zones[j]

      var compareZoneGeom = getDistZoneGeom(compareTzid)
      if(zoneGeom.intersects(compareZoneGeom)) {
        var intersectedGeom = debugGeo('intersection', zoneGeom, compareZoneGeom),
          intersectedArea = intersectedGeom.getArea()

        if(intersectedArea > 0.0001) {
          console.log('Validation error: ' + tzid + ' intersects ' + compareTzid + ' area: ' + intersectedArea)
          allZonesOk = false
        }
      }
    }
  }

  return allZonesOk ? null : 'Zone validation unsuccessful'

}

async.auto({
  makeDownloadsDir: function(cb) {
    console.log('creating downloads dir')
    safeMkdir('./downloads', cb)
  },
  makeDistDir: function(cb) {
    console.log('createing dist dir')
    safeMkdir('./dist', cb)
  },
  getOsmBoundaries: ['makeDownloadsDir', function(results, cb) {
    console.log('downloading osm boundaries')
    async.eachSeries(Object.keys(osmBoundarySources), downloadOsmBoundary, cb)
  }],
  createZones: ['makeDistDir', 'getOsmBoundaries', function(results, cb) {
    console.log('createZones')
    async.each(Object.keys(zoneCfg), makeTimezoneBoundary, cb)
  }],
  validateZones: ['createZones', function(results, cb) {
    console.log('validating zones')
    loadDistZonesIntoMemory()
    cb(validateTimezoneBoundaries())
  }],
  mergeZones: ['validateZones', function(results, cb) {
    // TODO: merge zones into single geojson file
    cb()
  }]
}, function(err, results) {
  console.log('done')
  if(err) {
    console.log('error!', err)
    return
  }
})
