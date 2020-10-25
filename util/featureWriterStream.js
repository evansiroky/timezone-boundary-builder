const fs = require('fs')

class FeatureWriterStream {
  constructor (file) {
    this.file = file
    this.stream = fs.createWriteStream(file)
    this.stream.write('{"type":"FeatureCollection","features":[')
    this.numFeatures = 0
  }

  add (stringifiedFeature) {
    if (this.numFeatures > 0) {
      this.stream.write(',')
    }
    this.stream.write(stringifiedFeature)
    this.numFeatures++
  }

  end (cb) {
    console.log(`Closing out file ${this.file}`)
    this.stream.end(']}', cb)
  }
}

module.exports = FeatureWriterStream
