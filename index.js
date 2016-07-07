var fs = require('fs'),
  http = require('http')

var async = require('async'),
  jsts = require('jsts'),
  overpass = require('query-overpass'),
  polygon = require('turf-polygon'),
  shp = require('shpjs')


var osmBoundarySources = require('./osmBoundarySources.json'),
  zoneCfg = require('./timezones.json'),
  geoJsonReader = new jsts.io.GeoJSONReader(),
  geoJsonWriter = new jsts.io.GeoJSONWriter(),
  efeleGeoms, efeleLookup = {}

var safeMkdir = function(dirname, callback) {
  fs.mkdir(dirname, function(err) {
    if(err && err.code === 'EEXIST') {
      callback()
    } else {
      callback(err)
    }
  })
}

var toArrayBuffer = function(buffer) {
  var ab = new ArrayBuffer(buffer.length)
  var view = new Uint8Array(ab)
  for (var i = 0; i < buffer.length; ++i) {
    view[i] = buffer[i]
  }
  return view
}

var extractToGeoJson = function(callback) {
  shp(toArrayBuffer(fs.readFileSync('./downloads/tz_world_mp.zip')))
    .then(function(geojson) { console.log('extract success'); return callback(null, geojson) })
    .catch(function(e){ console.log('extract err', e); callback(e) })
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

var downloadOsmBoundary = function(boundaryId, boundaryCallback) {
  var cfg = osmBoundarySources[boundaryId],
    query = '[out:json][timeout:60];',
    boundaryFilename = './downloads/' + cfg.type,
    debug = 'getting data for '

  if(cfg.type === 'ISO3166-1') {
    query += '(relation["boundary"="administrative"]' +
      '["admin_level"="2"]' +
      '["ISO3166-1"="' + cfg.code + '"]);' +
      'out body;>;out meta qt;'
    boundaryFilename += '_' + cfg.code
    debug += 'country: ' + cfg.code
  } else if(cfg.type === 'ISO3166-2') {
    query += '(relation["boundary"="administrative"]' +
      '["admin_level"="4"]' +
      '["ISO3166-2"="' + cfg.code + '"]);' +
      'out body;>;out meta qt;'
    boundaryFilename += '_' + cfg.code
    debug += 'state/province: ' + cfg.code
  } else if(cfg.type === 'city') {
    query += '(relation["boundary"="administrative"]' +
      '["admin_level"="8"]' +
      '["name"="' + cfg.name + '"]);' +
      'out body;>;out meta qt;'
    boundaryFilename += '_' + cfg.name
    debug += 'city: ' + cfg.name
  }

  boundaryFilename += '.json'

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
        var curGeom = data.features[i].geometry
        if(curGeom.type === 'Polygon' || curGeom.type === 'MultiPolygon') {
          console.log('combining border')
          if(!combined) {
            combined = curGeom
          } else {
            combined = union(curGeom, combined)
          }
        }
      }
      fs.writeFile(boundaryFilename, JSON.stringify(combined, null, 2), cb)
    }]
  }, boundaryCallback)
}

var getDataSource = function(source) {
  var geoJson
  if(source.source === 'efele') {
    geoJson = efeleGeoms[efeleLookup[source.id]].geometry
  } else if(source.source === 'overpass') {
    geoJson = require('./downloads/' + source.id + '.json')
  } else if(source.source === 'manual-polygon') {
    geoJson = polygon(source.data).geometry
  } else {
    var err = new Error('unknown source: ' + source.source)
    throw err
  }
  return geoJsonReader.read(JSON.stringify(geoJson))
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
    } else if(task.op === 'union') {
      geom = debugGeo('union', geom, taskData)
    }
    cb()
  }, function(err) {
    if(err) { return callback(err) }
    fs.writeFile('./dist/' + tzid.replace(/\//g, '__') + '.json', 
      JSON.stringify(geoJsonWriter.write(geom)), 
      callback)
  })
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
  getEfeleShapefile: ['makeDownloadsDir', function(results, cb) {
    console.log('download efele.net shapefile')
    var efeleFilename = './downloads/tz_world_mp.zip'
    fetchIfNeeded(efeleFilename, cb, function() {
      var file = fs.createWriteStream(efeleFilename)
      http.get('http://efele.net/maps/tz/world/tz_world_mp.zip', function(response) {
        response.pipe(file)
        file
          .on('finish', function() {
            file.close(cb)
          })
          .on('error', cb)
      })
    })
  }],
  getOsmBoundaries: ['makeDownloadsDir', function(results, cb) {
    console.log('downloading osm boundaries')
    async.eachSeries(Object.keys(osmBoundarySources), downloadOsmBoundary, cb)
  }],
  extractEfeleNetShapefile: ['getOsmBoundaries', function(results, cb) {
    console.log('extracting efele.net shapefile')
    extractToGeoJson(cb)
  }],
  dictifyEfeleNetData: ['extractEfeleNetShapefile', function(results, cb) {
    console.log('dictify efele.net')
    efeleGeoms = results.extractEfeleNetShapefile.features
    for (var i = efeleGeoms.length - 1; i >= 0; i--) {
      var curTz = efeleGeoms[i]
      efeleLookup[curTz.properties.TZID] = i
    }
    cb()
  }],
  createZones: ['makeDistDir', 'dictifyEfeleNetData', function(results, cb) {
    console.log('createZones')
    async.each(Object.keys(zoneCfg), makeTimezoneBoundary, cb)
  }],
  mergeZones: ['createZones', function(results, cb) {
    cb()
  }]
}, function(err, results) {
  console.log('done')
  if(err) {
    console.log('error!', err)
    return
  }
})