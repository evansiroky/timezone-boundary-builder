var fs = require('fs'),
  http = require('http')

var async = require('async'),
  overpass = require('query-overpass'),
  shp = require('shpjs')


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

var osmBoundarySources = require('./osmBoundarySources.json')

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
    console.log('downloads efele.net shapefile')
    return cb()
    var file = fs.createWriteStream('./downloads/tz_world_mp.zip')
    http.get('http://efele.net/maps/tz/world/tz_world_mp.zip', function(response) {
      response.pipe(file)
      file
        .on('finish', function() {
          file.close(cb)
        })
        .on('error', cb)
    })
  }],
  extractShapefile: ['getEfeleShapefile', function(results, cb) {
    console.log('extracting efele.net shapefile')
    extractToGeoJson(cb)
  }],
  getOsmBoundaries: ['makeDownloadsDir', function(results, cb) {
    console.log('downloading osm boundaries')
    var boundaryIds = Object.keys(osmBoundarySources)
    async.eachSeries(boundaryIds,
      function(boundaryId, boundaryCallback) {
        var cfg = osmBoundarySources[boundaryId]
        console.log('osm boundary for:', boundaryId, cfg.query)
        overpass(cfg.query, function(err, data) {
          if(err) { return boundaryCallback(err) }
          if(!data.features || data.features.length == 0) {
            err = new Error('Invalid geojson for boundary: ' + boundaryId)
            return boundaryCallback(err)
          }
          // union all multi-polygons / polygons into one
          fs.writeFile('./downloads/' + boundaryId, JSON.stringify(data, null, 2), boundaryCallback)
        }, { flatProperties: true })
      }, cb)
  }]
}, function(err) {
  console.log('done')
  if(err) {
    console.log('error!', err)
    return
  }

  //console.log(osmBoundarySources)
})