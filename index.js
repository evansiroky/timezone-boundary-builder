var fs = require('fs'),
  http = require('http')

var async = require('async'),
  jsts = require('jsts'),
  overpass = require('query-overpass'),
  shp = require('shpjs')


var osmBoundarySources = require('./osmBoundarySources.json'),
  zoneCfg = require('./timezones.json'),
  geoJsonReader = new jsts.io.GeoJSONReader(),
  geoJsonWriter = new jsts.io.GeoJSONWriter()


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
    .then(function(geojson) { console.log('extract success'); callback(null, geojson) })
    .catch(function(e){ console.log('extract err', e); callback(e) })
}

var union = function(a, b) {
  var _a = geoJsonReader.read(JSON.stringify(a)),
    _b = geoJsonReader.read(JSON.stringify(b))

  var result = _a.union(_b)

  return geoJsonWriter.write(result)

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
  }

  console.log(debug)

  async.auto({
    downloadFromOverpass: function(results, cb) {
      console.log('downloading from overpass')
      fetchIfNeeded(boundaryFilename, cb, function() {
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

async.auto({
  makeDownloadsDir: function(cb) {
    console.log('creating downloads dir')
    fs.mkdir('./downloads', function(err) {
      if(err && err.code === 'EEXIST') {
        cb()
      } else {
        cb(err)
      }
    })
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
    return cb()
    async.eachSeries(Object.keys(osmBoundarySources), downloadOsmBoundary, cb)
  }],
  extractEfeleNetShapefile: ['getOsmBoundaries', function(results, cb) {
    console.log('extracting efele.net shapefile')
    extractToGeoJson(cb)
  }],
  dictifyEfeleNetData: ['extractEfeleNetShapefile', function(results, cb) {
    var timezoneLookup = {}
    for (var i = results.extractEfeleNetShapefile.features.length - 1; i >= 0; i--) {
      var curTz = results.extractEfeleNetShapefile.features[i]
      timezoneLookup[curTz.properties.TZID] = i
    }
    cb(null, timezoneLookup)
  }],
  createZones: ['dictifyEfeleNetData', function(results, cb) {
    async.each(Object.keys(zoneCfg), makeTimezoneBoundary, cb)
  }],
  mergeZones: ['createZones', function(results, cb) {

  }]
}, function(err, results) {
  console.log('done')
  if(err) {
    console.log('error!', err)
    return
  }

  console.log(results.dictifyEfeleNetData)
})